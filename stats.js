class StatsTracker {
    constructor() {
        this.data = {
            letters: {}, // { "a": { times: [] } }
            bigrams: {},
            trigrams: {},
            quadgrams: {},
            runs: [] // chronological list of test WPM scores
        };
    }

    recordRun(wpm) {
        if (!this.data.runs) {
            this.data.runs = [];
        }
        this.data.runs.push(Math.round(wpm));
    }

    _ensureExists(dict, key) {
        if (!dict[key]) {
            dict[key] = { times: [] };
        }
    }

    recordTiming(sequence, time) {
        let targetDict;
        if (sequence.length === 1) targetDict = this.data.letters;
        else if (sequence.length === 2) targetDict = this.data.bigrams;
        else if (sequence.length === 3) targetDict = this.data.trigrams;
        else if (sequence.length === 4) targetDict = this.data.quadgrams;
        else return;

        this._ensureExists(targetDict, sequence);
        targetDict[sequence].times.push(Math.round(time));
    }

    recordMistake(sequence) {
        let targetDict;
        if (sequence.length === 1) targetDict = this.data.letters;
        else if (sequence.length === 2) targetDict = this.data.bigrams;
        else if (sequence.length === 3) targetDict = this.data.trigrams;
        else if (sequence.length === 4) targetDict = this.data.quadgrams;
        else return;
        
        this._ensureExists(targetDict, sequence);

        targetDict[sequence].mistakes = (targetDict[sequence].mistakes || 0) + 1;
    }

    exportData() {
        const json = JSON.stringify(this.data);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `typedeck_stats_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    importData(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            if (parsed.letters && parsed.bigrams && parsed.trigrams && parsed.quadgrams) {
                if (!parsed.runs) parsed.runs = [];
                this.data = parsed;
                return true;
            }
            return false;
        } catch (e) {
            console.error("Failed to parse data", e);
            return false;
        }
    }

    getWorst(type, limit = 10, minSamples = 5) {
        return this.getSpeedStats(type, limit, minSamples, 'desc');
    }

    getBest(type, limit = 10, minSamples = 5) {
        return this.getSpeedStats(type, limit, minSamples, 'asc');
    }

    getSpeedStats(type, limit = 10, minSamples = 5, order = 'desc') {
        const dict = this.data[type];
        if (!dict) return [];

        const stats = Object.keys(dict).map(key => {
            const item = dict[key];
            const avgTime = item.times.length > 0 
                ? item.times.reduce((a, b) => a + b, 0) / item.times.length 
                : 0;
            
            let totalMistakes = item.mistakes || 0;

            return {
                sequence: key,
                avgTime: avgTime,
                samples: item.times.length,
                mistakes: totalMistakes
            };
        }).filter(item => {
            return (item.samples + item.mistakes) >= minSamples;
        });

        if (order === 'asc') {
            stats.sort((a, b) => a.avgTime - b.avgTime);
        } else {
            stats.sort((a, b) => b.avgTime - a.avgTime);
        }
        return stats.slice(0, limit);
    }

    getMostMistakes(type, limit = 10, minSamples = 5) {
        return this.getMistakesStats(type, limit, minSamples, 'desc');
    }

    getFewestMistakes(type, limit = 10, minSamples = 5) {
        return this.getMistakesStats(type, limit, minSamples, 'asc');
    }

    getMistakesStats(type, limit = 10, minSamples = 5, order = 'desc') {
        const dict = this.data[type];
        if (!dict) return [];

        const stats = Object.keys(dict).map(key => {
            const item = dict[key];
            const avgTime = item.times.length > 0 
                ? item.times.reduce((a, b) => a + b, 0) / item.times.length 
                : 0;
            
            let totalMistakes = item.mistakes || 0;

            const occurrences = item.times.length + totalMistakes;
            const mistakeRatio = occurrences > 0 ? totalMistakes / occurrences : 0;
            return {
                sequence: key,
                avgTime: avgTime,
                samples: item.times.length,
                mistakes: totalMistakes,
                mistakeRatio: mistakeRatio
            };
        }).filter(item => {
            return (item.samples + item.mistakes) >= minSamples;
        });

        if (order === 'asc') {
            stats.sort((a, b) => a.mistakeRatio - b.mistakeRatio);
        } else {
            stats.sort((a, b) => b.mistakeRatio - a.mistakeRatio);
        }
        return stats.slice(0, limit);
    }
}
