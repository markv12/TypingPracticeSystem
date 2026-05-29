const NUM_WORDS = 50;

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
let invalidNextTiming = false; // flag to skip timing if we just backspaced

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

function getRandomWords(count) {
    const shuffled = [...demoWords].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

function startNewRun() {
    currentWords = getRandomWords(NUM_WORDS);
    targetText = currentWords.join(' ');
    
    // Reset state
    currentIndex = 0;
    extraChars = [];
    runStartTime = null;
    lastKeystrokeTime = null;
    hadMistake = new Array(targetText.length).fill(false);
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
            charSpans[currentIndex].classList.remove('correct');
            invalidNextTiming = true; // We don't want to track the time for the next correct char because it's a correction
            hadMistake[currentIndex] = true; // Mark as having had a mistake so we don't track its timing when re-typed
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
            statsTracker.recordMistake(expectedChar);
            if (currentIndex >= 1) {
                const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                statsTracker.recordMistake(bigram);
            }
            if (currentIndex >= 2) {
                const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                statsTracker.recordMistake(trigram);
            }
            hadMistake[currentIndex] = true;
        }
        
        // Create an extra char element and insert it BEFORE the current expected char
        const span = document.createElement('span');
        span.className = 'char wrong extra';
        span.textContent = e.key;
        
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
            
            // Only record timing if no mistake was made here and we didn't just backspace
            if (!hadMistake[currentIndex] && !invalidNextTiming) {
                // Record Letter
                statsTracker.recordTiming(expectedChar, timeDiff);
                
                // Record Bigram
                if (currentIndex >= 1) {
                    const bigram = targetText.substring(currentIndex - 1, currentIndex + 1);
                    statsTracker.recordTiming(bigram, timeDiff);
                }
                
                // Record Trigram
                if (currentIndex >= 2) {
                    const trigram = targetText.substring(currentIndex - 2, currentIndex + 1);
                    statsTracker.recordTiming(trigram, timeDiff);
                }
            }
            
            lastKeystrokeTime = now;
            invalidNextTiming = false; // Reset flag after one correct char
        }
        
        // Advance
        charSpans[currentIndex].classList.add('correct');
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
                alert('Data imported successfully!');
                if (viewStats.classList.contains('active-view')) {
                    renderStats();
                }
            } else {
                alert('Failed to import data. Invalid format.');
            }
        };
        reader.readAsText(file);
    });
}

function renderStats() {
    const minSamples = parseInt(minSeenInput.value, 10) || 1;
    const ignoreSpaces = ignoreSpaceInput.checked;
    
    // Slowest
    populateStatList('list-worst-letters', statsTracker.getWorst('letters', 10, minSamples, ignoreSpaces), 'time');
    populateStatList('list-worst-bigrams', statsTracker.getWorst('bigrams', 10, minSamples, ignoreSpaces), 'time');
    populateStatList('list-worst-trigrams', statsTracker.getWorst('trigrams', 10, minSamples, ignoreSpaces), 'time');

    // Most Mistakes
    populateStatList('list-mistakes-letters', statsTracker.getMostMistakes('letters', 10, minSamples, ignoreSpaces), 'mistakes');
    populateStatList('list-mistakes-bigrams', statsTracker.getMostMistakes('bigrams', 10, minSamples, ignoreSpaces), 'mistakes');
    populateStatList('list-mistakes-trigrams', statsTracker.getMostMistakes('trigrams', 10, minSamples, ignoreSpaces), 'mistakes');
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
        seqSpan.textContent = item.sequence.replace(/ /g, '␣');
        
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
            col2Span.textContent = item.mistakes;
            col2Span.style.color = "var(--error-red)";
            col3Span.textContent = occurrences;
            col3Span.style.color = "var(--text-muted)";
        }
        
        li.appendChild(seqSpan);
        li.appendChild(col2Span);
        li.appendChild(col3Span);
        ul.appendChild(li);
    });
}

// Start
init();
