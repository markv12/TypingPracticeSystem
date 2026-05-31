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
let keystrokeTimes = []; // absolute timestamps of correct keystrokes

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
const smoothingInput = document.getElementById('filter-smoothing');

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
        ...statsTracker.getWorst('letters', 5, minSamples),
        ...statsTracker.getWorst('bigrams', 5, minSamples),
        ...statsTracker.getWorst('trigrams', 5, minSamples),
        ...statsTracker.getWorst('quadgrams', 5, minSamples)
    ].map(s => s.sequence);

    const mistakeSequences = [
        ...statsTracker.getMostMistakes('letters', 5, minSamples),
        ...statsTracker.getMostMistakes('bigrams', 5, minSamples),
        ...statsTracker.getMostMistakes('trigrams', 5, minSamples),
        ...statsTracker.getMostMistakes('quadgrams', 5, minSamples)
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
    keystrokeTimes = new Array(targetText.length).fill(null);
    
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
                if (expectedChar !== ' ') {
                    statsTracker.recordMistake(expectedChar);
                }
                if (currentIndex >= 1) {
                    const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                    if (!bigram.includes(' ')) {
                        statsTracker.recordMistake(bigram);
                    }
                }
                if (currentIndex >= 2 && isCleanTiming[currentIndex - 1]) {
                    const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                    if (!trigram.includes(' ')) {
                        statsTracker.recordMistake(trigram);
                    }
                }
                if (currentIndex >= 3 && isCleanTiming[currentIndex - 1] && isCleanTiming[currentIndex - 2]) {
                    const quadgram = targetText.substring(currentIndex - 3, currentIndex + 1);
                    if (!quadgram.includes(' ')) {
                        statsTracker.recordMistake(quadgram);
                    }
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
        keystrokeTimes[currentIndex] = now;
        
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
                // Record Letter (1 transition)
                if (expectedChar !== ' ') {
                    statsTracker.recordTiming(expectedChar, timeDiff);
                }
                
                // Record Bigram (1 transition)
                if (currentIndex >= 1) {
                    const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                    if (!bigram.includes(' ')) {
                        const totalTime = keystrokeTimes[currentIndex] - keystrokeTimes[currentIndex - 1];
                        statsTracker.recordTiming(bigram, totalTime);
                    }
                }
                
                // Record Trigram (2 transitions)
                if (currentIndex >= 2 && isCleanTiming[currentIndex - 1]) {
                    const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                    if (!trigram.includes(' ')) {
                        const totalTime = keystrokeTimes[currentIndex] - keystrokeTimes[currentIndex - 2];
                        statsTracker.recordTiming(trigram, totalTime);
                    }
                }
                
                // Record Quadgram (3 transitions)
                if (currentIndex >= 3 && isCleanTiming[currentIndex - 1] && isCleanTiming[currentIndex - 2]) {
                    const quadgram = targetText.substring(currentIndex - 3, currentIndex + 1);
                    if (!quadgram.includes(' ')) {
                        const totalTime = keystrokeTimes[currentIndex] - keystrokeTimes[currentIndex - 3];
                        statsTracker.recordTiming(quadgram, totalTime);
                    }
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

    document.getElementById('smoothing-dec').addEventListener('click', () => {
        let val = parseInt(smoothingInput.value, 10);
        if (val > 1) {
            smoothingInput.value = val - 1;
        }
    });

    document.getElementById('smoothing-inc').addEventListener('click', () => {
        let val = parseInt(smoothingInput.value, 10);
        smoothingInput.value = val + 1;
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
    
    // Slowest
    populateStatList('list-worst-letters', statsTracker.getWorst('letters', 20, minSamples), 'time');
    populateStatList('list-worst-bigrams', statsTracker.getWorst('bigrams', 20, minSamples), 'time');
    populateStatList('list-worst-trigrams', statsTracker.getWorst('trigrams', 20, minSamples), 'time');
    populateStatList('list-worst-quadgrams', statsTracker.getWorst('quadgrams', 20, minSamples), 'time');

    // Most Mistakes
    populateStatList('list-mistakes-letters', statsTracker.getMostMistakes('letters', 20, minSamples), 'mistakes');
    populateStatList('list-mistakes-bigrams', statsTracker.getMostMistakes('bigrams', 20, minSamples), 'mistakes');
    populateStatList('list-mistakes-trigrams', statsTracker.getMostMistakes('trigrams', 20, minSamples), 'mistakes');
    populateStatList('list-mistakes-quadgrams', statsTracker.getMostMistakes('quadgrams', 20, minSamples), 'mistakes');
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

        if (primaryStat === 'time') {
            const rawSeq = item.sequence;
            li.addEventListener('mouseenter', (e) => showChartTooltip(e, rawSeq));
            li.addEventListener('mousemove', (e) => moveChartTooltip(e));
            li.addEventListener('mouseleave', () => hideChartTooltip());
        }

        ul.appendChild(li);
    });
}

// Start
init();

// --- Chart Tooltip ---
const chartTooltip = document.getElementById('chart-tooltip');
const chartTitle = document.getElementById('chart-tooltip-title');
const chartContainer = document.getElementById('chart-container');

function showChartTooltip(e, sequence) {
    let times = [];
    if (sequence.length === 1 && statsTracker.data.letters[sequence]) times = statsTracker.data.letters[sequence].times;
    else if (sequence.length === 2 && statsTracker.data.bigrams[sequence]) times = statsTracker.data.bigrams[sequence].times;
    else if (sequence.length === 3 && statsTracker.data.trigrams[sequence]) times = statsTracker.data.trigrams[sequence].times;
    else if (sequence.length === 4 && statsTracker.data.quadgrams[sequence]) times = statsTracker.data.quadgrams[sequence].times;

    if (!times || times.length === 0) return;

    const displaySeq = sequence === ' ' ? 'Space' : sequence;
    chartTitle.textContent = `Speed History: "${displaySeq}"`;
    renderChart(times);

    chartTooltip.classList.add('visible');
    moveChartTooltip(e);
}

function moveChartTooltip(e) {
    let x = e.clientX + 15;
    let y = e.clientY + 15;
    
    // Use requestAnimationFrame or setTimeout to ensure dimensions are computed before positioning
    const tooltipRect = chartTooltip.getBoundingClientRect();
    if (x + tooltipRect.width > window.innerWidth) {
        x = e.clientX - tooltipRect.width - 15;
    }
    if (y + tooltipRect.height > window.innerHeight) {
        y = e.clientY - tooltipRect.height - 15;
    }

    chartTooltip.style.left = `${x}px`;
    chartTooltip.style.top = `${y}px`;
}

function hideChartTooltip() {
    chartTooltip.classList.remove('visible');
}

function renderChart(times) {
    const smoothing = parseInt(smoothingInput.value, 10) || 1;
    
    // Calculate simple moving average
    const smoothedData = [];
    for (let i = 0; i < times.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - smoothing + 1); j <= i; j++) {
            sum += times[j];
            count++;
        }
        smoothedData.push(sum / count);
    }

    if (smoothedData.length < 2) {
        chartContainer.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding-top:40px;">Not enough data</div>';
        return;
    }

    const maxVal = Math.max(...smoothedData);
    const minVal = Math.min(...smoothedData);
    const range = maxVal - minVal;
    const padding = range === 0 ? maxVal * 0.1 : range * 0.1;
    
    // Since lower time is better (faster), we invert the Y-axis so faster = higher on graph
    // Wait, usually lower time = lower bar, but if we want to show speed, maybe speed = 1/time?
    // Let's stick to literal time: lower value = lower down, higher value = higher up.
    // Or we can invert it so going UP means improving (faster).
    // Let's use literal time: y=0 is highest time (top of chart), y=height is lowest time (bottom of chart). Wait, if yMax is at bottom, then lower time is lower visually. Let's make it standard: higher time goes higher on the Y axis.
    const yMin = Math.max(0, minVal - padding);
    const yMax = maxVal + padding;

    const width = 250;
    const height = 120;
    const paddingLeft = 45;
    const chartWidth = width - paddingLeft;

    const points = smoothedData.map((val, index) => {
        const xRatio = smoothedData.length > 1 ? index / (smoothedData.length - 1) : 0;
        const x = paddingLeft + xRatio * chartWidth;
        const y = height - ((val - yMin) / (yMax - yMin)) * height;
        return `${x},${y}`;
    }).join(' ');

    const svg = `
        <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
            <text x="0" y="12" class="chart-label">${Math.round(maxVal)}ms</text>
            <text x="0" y="${height - 2}" class="chart-label">${Math.round(minVal)}ms</text>
            <line x1="${paddingLeft - 5}" y1="0" x2="${paddingLeft - 5}" y2="${height}" class="chart-axis" />
            <polyline class="chart-line" points="${points}" />
        </svg>
    `;

    chartContainer.innerHTML = svg;
}
