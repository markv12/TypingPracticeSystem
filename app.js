const NUM_WORDS = 48;

// State
let statsTracker = new StatsTracker();
let currentWords = [];
let targetText = "";
let charSpans = []; // DOM elements for each character in targetText
let currentIndex = 0;
let extraChars = []; // Stack of { char: string, element: HTMLElement }

let runStartTime = null;
let lastKeystrokeTime = null;
let hadMistake = []; // boolean array tracking if a mistake was made at index
let isRetyped = []; // boolean array tracking if a character was backspaced over
let isCleanTiming = []; // boolean array tracking if the keystroke was clean (no mistake, no long pause)
let invalidNextTiming = false; // flag to skip timing if we just backspaced

let syncFileHandle = null;

// --- IndexedDB for File Handle Persistence ---
const DB_NAME = 'TypoDecoDB';
const STORE_NAME = 'handles';

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveHandle(handle) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, 'syncHandle');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function loadHandle() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get('syncHandle');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
// ---------------------------------------------

async function syncDataToFile() {
    if (!syncFileHandle) return;
    try {
        const writable = await syncFileHandle.createWritable();
        await writable.write(JSON.stringify(statsTracker.data));
        await writable.close();
    } catch (e) {
        console.error("Failed to sync to file:", e);
    }
}

// DOM Elements
const typingContainer = document.getElementById('typing-container');
const prevWpmEl = document.getElementById('prev-wpm');

// Views
const btnPractice = document.getElementById('nav-practice');
const btnStats = document.getElementById('nav-stats');
const viewPractice = document.getElementById('view-practice');
const viewStats = document.getElementById('view-stats');
const minSeenInput = document.getElementById('filter-min-seen');
const ignoreSpaceInput = document.getElementById('filter-ignore-space');

function init() {
    setupNavigation();
    setupStatsControls();
    startNewRun();
    
    // Global keyboard listener
    document.addEventListener('keydown', handleKeyDown);
}

function getPracticeWords(count) {
    const minSamples = parseInt(minSeenInput.value, 10) || 1;
    
    const worstSequences = [
        ...statsTracker.getWorst('letters', 5, minSamples, true),
        ...statsTracker.getWorst('bigrams', 5, minSamples, true),
        ...statsTracker.getWorst('trigrams', 5, minSamples, true)
    ].map(s => s.sequence);

    const mistakeSequences = [
        ...statsTracker.getMostMistakes('letters', 5, minSamples, true),
        ...statsTracker.getMostMistakes('bigrams', 5, minSamples, true),
        ...statsTracker.getMostMistakes('trigrams', 5, minSamples, true)
    ].map(s => s.sequence);

    const words = [];
    const countSlow = Math.floor(count / 3);
    const countMistake = Math.floor(count / 3);
    const countRandom = count - countSlow - countMistake;

    function getWordContaining(seq) {
        const matching = demoWords.filter(w => w.includes(seq));
        if (matching.length > 0) {
            return matching[Math.floor(Math.random() * matching.length)];
        }
        return demoWords[Math.floor(Math.random() * demoWords.length)];
    }

    function getPureRandomWord() {
        return demoWords[Math.floor(Math.random() * demoWords.length)];
    }

    for (let i = 0; i < countSlow; i++) {
        if (worstSequences.length > 0) {
            const seq = worstSequences[Math.floor(Math.random() * worstSequences.length)];
            words.push(getWordContaining(seq));
        } else {
            words.push(getPureRandomWord());
        }
    }

    for (let i = 0; i < countMistake; i++) {
        if (mistakeSequences.length > 0) {
            const seq = mistakeSequences[Math.floor(Math.random() * mistakeSequences.length)];
            words.push(getWordContaining(seq));
        } else {
            words.push(getPureRandomWord());
        }
    }

    for (let i = 0; i < countRandom; i++) {
        words.push(getPureRandomWord());
    }

    return words.sort(() => 0.5 - Math.random());
}

function startNewRun() {
    currentWords = getPracticeWords(NUM_WORDS);
    targetText = currentWords.join(' ');
    
    // Reset state
    currentIndex = 0;
    extraChars = [];
    runStartTime = null;
    lastKeystrokeTime = null;
    hadMistake = new Array(targetText.length).fill(false);
    isRetyped = new Array(targetText.length).fill(false);
    isCleanTiming = new Array(targetText.length).fill(false);
    invalidNextTiming = false;
    
    renderWords();
}

function renderWords() {
    typingContainer.innerHTML = '';
    charSpans = [];
    
    let globalIndex = 0;
    for (let i = 0; i < currentWords.length; i++) {
        const wordEl = document.createElement('div');
        wordEl.className = 'word';
        
        const word = currentWords[i];
        for (let j = 0; j < word.length; j++) {
            const span = document.createElement('span');
            span.className = 'char';
            span.textContent = word[j];
            wordEl.appendChild(span);
            charSpans.push(span);
            globalIndex++;
        }
        
        // Add space after word, except for the last word
        if (i < currentWords.length - 1) {
            const span = document.createElement('span');
            span.className = 'char space';
            span.innerHTML = ' '; // Normal space works well with white-space: pre-wrap
            wordEl.appendChild(span);
            charSpans.push(span);
            globalIndex++;
        }
        
        typingContainer.appendChild(wordEl);
    }
    
    updateCursor();
}

function updateCursor() {
    // Remove current from all
    charSpans.forEach(span => span.classList.remove('current'));
    if (currentIndex < charSpans.length) {
        charSpans[currentIndex].classList.add('current');
    }
}

function finishRun() {
    if (!runStartTime) return;
    const now = performance.now();
    const timeInMinutes = (now - runStartTime) / 60000;
    // Standard WPM: characters / 5 / minutes
    const wpm = (targetText.length / 5) / timeInMinutes;
    
    prevWpmEl.textContent = Math.round(wpm);
    
    // Auto-sync
    syncDataToFile();
    
    startNewRun();
}

function handleKeyDown(e) {
    // Ignore if not in practice view
    if (!viewPractice.classList.contains('active-view')) return;
    
    // Ignore modifiers and functional keys
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length > 1 && e.key !== 'Backspace') return;

    // Prevent default scrolling for Space
    if (e.key === ' ') e.preventDefault();

    const now = performance.now();

    if (e.key === 'Backspace') {
        if (extraChars.length > 0) {
            // Remove the last extra character
            const extra = extraChars.pop();
            extra.element.remove();
        } else if (currentIndex > 0) {
            // Move cursor back over target text
            currentIndex--;
            charSpans[currentIndex].classList.remove('correct', 'was-mistake');
            if (targetText[currentIndex] === ' ') {
                charSpans[currentIndex].textContent = ' ';
            }
            invalidNextTiming = true; // We don't want to track the time for the next correct char because it's a correction
            isRetyped[currentIndex] = true; // Mark as having been retyped so we don't track its timing
            updateCursor();
        }
        return;
    }

    // It's a printable character
    const expectedChar = targetText[currentIndex];

    if (extraChars.length > 0 || e.key !== expectedChar) {
        // Mistake!
        // Record mistake if it's the first mistake at this position
        if (extraChars.length === 0 && currentIndex < targetText.length) {
            const timeDiff = lastKeystrokeTime ? (now - lastKeystrokeTime) : 0;
            if (timeDiff <= 1500) {
                statsTracker.recordMistake(expectedChar);
                if (currentIndex >= 1) {
                    const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                    statsTracker.recordMistake(bigram);
                }
                if (currentIndex >= 2 && isCleanTiming[currentIndex - 1]) {
                    const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                    statsTracker.recordMistake(trigram);
                }
            }
            hadMistake[currentIndex] = true;
        }
        
        // Create an extra char element and insert it BEFORE the current expected char
        const span = document.createElement('span');
        span.className = 'char wrong extra';
        span.textContent = e.key === ' ' ? '_' : e.key;
        
        if (currentIndex < charSpans.length) {
            charSpans[currentIndex].parentNode.insertBefore(span, charSpans[currentIndex]);
        } else {
            // If at the very end, append to the last word
            typingContainer.lastChild.appendChild(span);
        }
        
        extraChars.push({ char: e.key, element: span });
        
    } else if (e.key === expectedChar) {
        // Correct character typed
        if (currentIndex === 0) {
            runStartTime = now;
            lastKeystrokeTime = now;
        } else {
            const timeDiff = now - lastKeystrokeTime;
            
            let isClean = true;
            if (timeDiff > 1500) isClean = false;
            if (hadMistake[currentIndex]) isClean = false;
            if (isRetyped[currentIndex]) isClean = false;
            if (invalidNextTiming) isClean = false;

            if (isClean) {
                // Record Letter
                statsTracker.recordTiming(expectedChar, timeDiff);
                
                // Record Bigram
                if (currentIndex >= 1) {
                    const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                    statsTracker.recordTiming(bigram, timeDiff);
                }
                
                // Record Trigram
                if (currentIndex >= 2 && isCleanTiming[currentIndex - 1]) {
                    const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                    statsTracker.recordTiming(trigram, timeDiff);
                }
                
                isCleanTiming[currentIndex] = true;
            }
            
            lastKeystrokeTime = now;
            invalidNextTiming = false; // Reset flag after one correct char
        }
        
        // Advance
        if (hadMistake[currentIndex]) {
            charSpans[currentIndex].classList.add('was-mistake');
            if (expectedChar === ' ') {
                charSpans[currentIndex].textContent = '_';
            }
        } else {
            charSpans[currentIndex].classList.add('correct');
        }
        currentIndex++;
        updateCursor();
        
        // Check for run completion
        if (currentIndex === targetText.length && extraChars.length === 0) {
            finishRun();
        }
    }
}

// Navigation & Stats UI
function setupNavigation() {
    btnPractice.addEventListener('click', () => {
        btnPractice.classList.add('active');
        btnStats.classList.remove('active');
        viewPractice.classList.add('active-view');
        viewStats.classList.remove('active-view');
        
        // Ensure we can continue typing immediately
        typingContainer.focus();
    });

    btnStats.addEventListener('click', () => {
        btnStats.classList.add('active');
        btnPractice.classList.remove('active');
        viewStats.classList.add('active-view');
        viewPractice.classList.remove('active-view');
        
        renderStats();
    });
}

function setupStatsControls() {
    document.getElementById('btn-export').addEventListener('click', () => {
        statsTracker.exportData();
    });

    minSeenInput.addEventListener('change', () => {
        if (viewStats.classList.contains('active-view')) renderStats();
    });

    document.getElementById('min-seen-dec').addEventListener('click', () => {
        let val = parseInt(minSeenInput.value, 10);
        if (val > 1) {
            minSeenInput.value = val - 1;
            if (viewStats.classList.contains('active-view')) renderStats();
        }
    });

    document.getElementById('min-seen-inc').addEventListener('click', () => {
        let val = parseInt(minSeenInput.value, 10);
        minSeenInput.value = val + 1;
        if (viewStats.classList.contains('active-view')) renderStats();
    });

    ignoreSpaceInput.addEventListener('change', () => {
        if (viewStats.classList.contains('active-view')) renderStats();
    });

    document.getElementById('file-import').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            const success = statsTracker.importData(event.target.result);
            if (success) {
                if (viewStats.classList.contains('active-view')) {
                    renderStats();
                }
            } else {
                alert('Failed to import data. Invalid format.');
            }
        };
        reader.readAsText(file);
    });

    const btnSync = document.getElementById('btn-sync');
    if ('showOpenFilePicker' in window) {
        btnSync.style.display = 'inline-block';
        
        // Try to load existing handle from IndexedDB
        loadHandle().then(async (handle) => {
            if (handle) {
                syncFileHandle = handle;
                if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
                    // We have permission! Load data
                    try {
                        const file = await handle.getFile();
                        const text = await file.text();
                        if (text && text.trim().length > 0) {
                            statsTracker.importData(text);
                            if (viewStats.classList.contains('active-view')) renderStats();
                        }
                        btnSync.textContent = `Syncing to: ${handle.name}`;
                        btnSync.classList.remove('outline');
                    } catch (e) {
                        console.error("Failed to read from restored handle", e);
                    }
                } else {
                    // We have the handle but need the user to click to request permission
                    btnSync.textContent = `Resume Sync: ${handle.name}`;
                }
            }
        }).catch(e => console.error("Could not load handle from IndexedDB", e));

        btnSync.addEventListener('click', async () => {
            try {
                // If we have a handle but lack permission, just request permission
                if (syncFileHandle && (await syncFileHandle.queryPermission({mode: 'readwrite'})) !== 'granted') {
                    if ((await syncFileHandle.requestPermission({mode: 'readwrite'})) === 'granted') {
                        const file = await syncFileHandle.getFile();
                        const text = await file.text();
                        if (text && text.trim().length > 0) {
                            statsTracker.importData(text);
                            if (viewStats.classList.contains('active-view')) renderStats();
                        }
                        btnSync.textContent = `Syncing to: ${syncFileHandle.name}`;
                        btnSync.classList.remove('outline');
                        await syncDataToFile();
                    }
                    return; 
                }

                // Normal flow: select new file
                const [handle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'JSON Files',
                        accept: { 'application/json': ['.json'] },
                    }],
                    multiple: false
                });
                
                const file = await handle.getFile();
                const text = await file.text();
                
                if (text && text.trim().length > 0) {
                    const success = statsTracker.importData(text);
                    if (!success) {
                        alert('The selected file is not a valid TypoDeco save file. Sync aborted to prevent overwriting your file.');
                        return;
                    }
                    if (viewStats.classList.contains('active-view')) renderStats();
                }

                syncFileHandle = handle;
                await saveHandle(handle); // Save to IndexedDB
                
                btnSync.textContent = `Syncing to: ${syncFileHandle.name}`;
                btnSync.classList.remove('outline');
                
                await syncDataToFile();
            } catch (e) {
                console.error(e);
            }
        });
    }
}

function renderStats() {
    const minSamples = parseInt(minSeenInput.value, 10) || 1;
    const ignoreSpaces = ignoreSpaceInput.checked;
    
    // Slowest
    populateStatList('list-worst-letters', statsTracker.getWorst('letters', 20, minSamples, ignoreSpaces), 'time');
    populateStatList('list-worst-bigrams', statsTracker.getWorst('bigrams', 20, minSamples, ignoreSpaces), 'time');
    populateStatList('list-worst-trigrams', statsTracker.getWorst('trigrams', 20, minSamples, ignoreSpaces), 'time');

    // Most Mistakes
    populateStatList('list-mistakes-letters', statsTracker.getMostMistakes('letters', 20, minSamples, ignoreSpaces), 'mistakes');
    populateStatList('list-mistakes-bigrams', statsTracker.getMostMistakes('bigrams', 20, minSamples, ignoreSpaces), 'mistakes');
    populateStatList('list-mistakes-trigrams', statsTracker.getMostMistakes('trigrams', 20, minSamples, ignoreSpaces), 'mistakes');
}

function populateStatList(elementId, items, primaryStat) {
    const ul = document.getElementById(elementId);
    ul.innerHTML = '';
    
    if (items.length === 0) {
        ul.innerHTML = '<li style="justify-content: center; color: var(--text-muted)">No data yet</li>';
        return;
    }
    
    items.forEach(item => {
        const li = document.createElement('li');
        
        const seqSpan = document.createElement('span');
        seqSpan.className = 'stat-seq';
        // Replace space with a visible character for clarity in stats
        seqSpan.textContent = item.sequence.replace(/ /g, '_');
        
        const col2Span = document.createElement('span');
        col2Span.className = 'stat-time';
        
        const col3Span = document.createElement('span');
        col3Span.className = 'stat-mistakes';
        
        const occurrences = item.samples + item.mistakes;

        if (primaryStat === 'time') {
            col2Span.textContent = item.avgTime > 0 ? `${Math.round(item.avgTime)}ms` : '--';
            col3Span.textContent = occurrences;
            col3Span.style.color = "var(--text-muted)";
        } else {
            const ratio = occurrences > 0 ? item.mistakes / occurrences : 0;
            const percentage = Math.round(ratio * 10000) / 100;
            col2Span.textContent = `${percentage}%`;
            col2Span.style.color = "var(--error-red)";
            col3Span.textContent = `${item.mistakes} / ${occurrences}`;
            col3Span.style.color = "var(--text-muted)";
        }
        
        li.appendChild(seqSpan);
        li.appendChild(col2Span);
        li.appendChild(col3Span);

        // Removed tooltip logic since mistake details are no longer tracked.

        ul.appendChild(li);
    });
}

// Start
init();
