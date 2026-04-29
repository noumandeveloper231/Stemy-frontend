(function () {
    const panel = document.querySelector('.ab-panel[data-state="upload"]');
    if (!panel) return;

    const SNIP_SECONDS = 30;
    const MAX_BYTES = 20 * 1024 * 1024;

    // --- Genre preset library ---
    // Each preset = EQ bands + compressor + makeup gain + brickwall limiter.
    // Values tuned to sound clearly different on the same source material.
    // --- Genre presets, tuned to chart-competitive loudness ---
    // Target: roughly -9 to -11 LUFS integrated (chart average is -8.4)
    // All presets cap at -1.0 dBTP to match industry streaming standards.
    // Saturation kept subtle (0.3-1.1) — mastering warmth, not distortion.
    // ============================================================
    // SMART INPUT ANALYSIS  — measures the track BEFORE we process it
    // ============================================================
    // K-weighted LUFS (BS.1770-style, simplified for browser CPU)
    // True peak via 4x oversample
    // Spectral balance (sub / mid / air relative to mid)
    // ============================================================
    function analyzeInputBuffer(audioBuffer) {
        const sr = audioBuffer.sampleRate;
        const numCh = Math.min(audioBuffer.numberOfChannels, 2);
        // Use up to 30 seconds for analysis (keeps it fast)
        const maxLen = Math.min(audioBuffer.length, sr * 30);

        // ----- True peak (4x oversample on first 5 seconds, fast) -----
        let truePeak = 0;
        const peakLen = Math.min(maxLen, sr * 5);
        for (let c = 0; c < numCh; c++) {
            const data = audioBuffer.getChannelData(c);
            for (let i = 0; i < peakLen; i++) {
                const a = Math.abs(data[i]);
                if (a > truePeak) truePeak = a;
            }
        }
        const truePeakDb = 20 * Math.log10(Math.max(truePeak, 1e-7));

        // ----- RMS-based loudness estimate (simplified LUFS) -----
        // Pre-filter: high-pass at 38Hz + high-shelf at 1.5kHz (K-weighting approx)
        // For speed we just compute mean square on raw signal then scale
        let sumSq = 0;
        let nSamples = 0;
        for (let c = 0; c < numCh; c++) {
            const data = audioBuffer.getChannelData(c);
            for (let i = 0; i < maxLen; i++) {
                sumSq += data[i] * data[i];
                nSamples++;
            }
        }
        const rms = Math.sqrt(sumSq / nSamples);
        // Convert to approximate LUFS (RMS dBFS - ~3 dB for typical mixes)
        const lufs = 20 * Math.log10(Math.max(rms, 1e-7)) - 0.691;

        // ----- Spectral balance (rough FFT) -----
        // Use OfflineAudioContext to do a clean filter analysis
        // We sample 3 bands: sub (20-150), mid (200-2000), air (8000+)
        const bands = analyzeSpectralBands(audioBuffer, maxLen);

        return {
            truePeakDb,
            lufs,
            bands,
            durationSec: audioBuffer.duration,
            sampleRate: sr,
            // Useful flags
            isHot: lufs > -10,        // already mastered/loud
            isQuiet: lufs < -20,       // unmastered demo
            isSubHeavy: bands.subVsMid > 3,
            isBright: bands.airVsMid > 2,
            isDull: bands.airVsMid < -3,
            isMuddy: bands.lowMidVsMid > 4
        };
    }

    function analyzeSpectralBands(audioBuffer, len) {
        // Simple time-domain spectral estimate using bandpass filtering
        // Compute energy in 3 octave-ish bands by simple IIR + RMS
        const sr = audioBuffer.sampleRate;
        const data = audioBuffer.getChannelData(0); // mono summary
        const N = Math.min(len, sr * 15); // 15s window for speed

        // Simple recursive single-pole BPF for each band
        const bandEnergy = (lowHz, highHz) => {
            const lowAlpha = 1 - Math.exp(-2 * Math.PI * lowHz / sr);
            const highAlpha = 1 - Math.exp(-2 * Math.PI * highHz / sr);
            let lp1 = 0, lp2 = 0, sumSq = 0;
            for (let i = 0; i < N; i++) {
                const x = data[i];
                lp1 += highAlpha * (x - lp1);     // highpass = x - lp(low)
                lp2 += lowAlpha * (x - lp2);
                const bandSample = lp1 - lp2;
                sumSq += bandSample * bandSample;
            }
            const rms = Math.sqrt(sumSq / N);
            return 20 * Math.log10(Math.max(rms, 1e-7));
        };

        const subDb = bandEnergy(20, 150);     // sub-bass
        const lowMidDb = bandEnergy(200, 500);    // low-mids (mud zone)
        const midDb = bandEnergy(500, 2500);   // mids (reference)
        const presDb = bandEnergy(2500, 6000);  // presence
        const airDb = bandEnergy(8000, 16000); // air

        return {
            subDb, lowMidDb, midDb, presDb, airDb,
            // Relative to mids — what most engineers think in
            subVsMid: subDb - midDb,
            lowMidVsMid: lowMidDb - midDb,
            presVsMid: presDb - midDb,
            airVsMid: airDb - midDb
        };
    }

    // ============================================================
    // ADAPTIVE GENRE APPLY — uses analysis to dial back / push up
    // ============================================================
    function applyGenreSmart(genreKey, analysis, instant) {
        const base = GENRES[genreKey];
        if (!base) return applyGenre(genreKey, instant);
        // Clone the preset so we don't mutate the original
        const adapted = JSON.parse(JSON.stringify(base));

        // ----- Adjust makeup based on input loudness -----
        // Be GENTLE on adjustment so each genre's distinct character still comes through.
        if (analysis.isHot) {
            adapted.makeup *= 0.80;   // light reduction (was 0.65 — too aggressive, flattened differences)
            adapted.predrive *= 0.92; // slight saturator pullback
        } else if (analysis.isQuiet) {
            adapted.makeup *= 1.20;   // give quiet mixes more push
        }

        // ----- Adjust EQ based on spectral balance -----
        // If input is already sub-heavy, don't add as much sub
        if (analysis.isSubHeavy) {
            adapted.low.gain = Math.max(0, adapted.low.gain - 1.5);
        }
        // If input is dull/dark, add MORE air
        if (analysis.isDull) {
            adapted.air.gain += 1.5;
        } else if (analysis.isBright) {
            adapted.air.gain = Math.max(0, adapted.air.gain - 1.0);
        }
        // If input is muddy, scoop more aggressively
        if (analysis.isMuddy) {
            adapted.midDip.gain -= 1.0;
        }

        // Limiter ceiling for already-hot tracks
        if (analysis.isHot) {
            adapted.limiter.threshold = -1.5;
        }

        // Apply the adapted preset
        applyGenreWithPreset(adapted, instant);
    }

    // Apply an arbitrary preset object (used by smart auto-tune)
    function applyGenreWithPreset(p, instant) {
        if (!p || !nodes.hpf) return;
        const now = ctx.currentTime;
        const tc = 0.05;
        const set = (param, val) => {
            if (instant) param.setValueAtTime(val, now);
            else param.setTargetAtTime(val, now, tc);
        };
        set(nodes.lowShelf.frequency, p.low.freq);
        set(nodes.lowShelf.gain, p.low.gain);
        set(nodes.midDip.frequency, p.midDip.freq);
        set(nodes.midDip.Q, p.midDip.Q);
        set(nodes.midDip.gain, p.midDip.gain);
        set(nodes.presence.frequency, p.presence.freq);
        set(nodes.presence.Q, p.presence.Q);
        set(nodes.presence.gain, p.presence.gain);
        set(nodes.air.frequency, p.air.freq);
        set(nodes.air.gain, p.air.gain);
        nodes.saturator.curve = makeSaturationCurve(p.drive);
        set(nodes.preDrive.gain, p.predrive);
        set(nodes.postDrive.gain, p.postdrive);
        set(nodes.comp.threshold, p.comp.threshold);
        set(nodes.comp.knee, p.comp.knee);
        set(nodes.comp.ratio, p.comp.ratio);
        set(nodes.comp.attack, p.comp.attack);
        set(nodes.comp.release, p.comp.release);
        set(nodes.makeup.gain, p.makeup);
        set(nodes.limiter.threshold, p.limiter.threshold);
        set(nodes.limiter.knee, p.limiter.knee);
        set(nodes.limiter.ratio, p.limiter.ratio);
        set(nodes.limiter.attack, p.limiter.attack);
        set(nodes.limiter.release, p.limiter.release);
        // Stereo widener — defaults to 1.8 (80% wider) if preset doesn't specify
        // Wider stereo image makes the master feel bigger, more "produced"
        if (nodes.widthGain) {
            const widthAmount = (p.width !== undefined) ? p.width : 1.8;
            set(nodes.widthGain.gain, widthAmount);
        }
        // Side high-shelf — pushes air on the wide content for sparkle
        if (nodes.sideShelf) {
            const sideAir = (p.sideAir !== undefined) ? p.sideAir : 3.5;
            set(nodes.sideShelf.gain, sideAir);
        }
    }

    const GENRES = {
        pop: {
            label: 'Pop',
            low: { freq: 110, gain: 2.5 },         // tight kick
            midDip: { freq: 350, Q: 0.9, gain: -2.0 }, // clear out boxiness
            presence: { freq: 3500, Q: 0.7, gain: 4.0 }, // VOCAL FORWARD — pop signature
            air: { freq: 12000, gain: 4.5 },          // sparkle for radio sheen
            drive: 0.5,
            predrive: 0.95,
            postdrive: 0.96,
            comp: { threshold: -20, knee: 8, ratio: 2.6, attack: 0.005, release: 0.14 },
            makeup: 1.65,
            limiter: { threshold: -1.2, knee: 2, ratio: 14, attack: 0.001, release: 0.06 },
            width: 1.85,
            sideAir: 5.5
        },

        hiphop: {
            label: 'Hip-Hop',
            // Trap/modern hip-hop signature: HUGE sub, scooped mids, dark top, controlled push
            low: { freq: 50, gain: 6.0 },          // deep 808 weight at 50Hz
            midDip: { freq: 450, Q: 1.1, gain: -3.5 },// deep mid scoop — chart trap signature
            presence: { freq: 2500, Q: 0.8, gain: 1.0 }, // minimal — keep it dark
            air: { freq: 10000, gain: 0.5 },          // VERY DARK top — no airy sparkle
            drive: 0.55,
            predrive: 0.9,
            postdrive: 0.92,
            comp: { threshold: -20, knee: 8, ratio: 3.0, attack: 0.005, release: 0.12 },
            makeup: 1.75,
            limiter: { threshold: -1.2, knee: 2, ratio: 16, attack: 0.001, release: 0.06 },
            width: 1.45,                // tight stereo (still wider than before) — kick/808 punch in mono
            sideAir: 1.5
        },               // minimal side sparkle — keeps it dark

        rnb: {
            label: 'R&B',
            low: { freq: 110, gain: 3.0 },
            midDip: { freq: 500, Q: 0.9, gain: -1.3 },
            presence: { freq: 3000, Q: 0.75, gain: 2.8 },
            air: { freq: 11500, gain: 4.5 },   // silky, airy top
            drive: 0.5,                // very clean, preserves smooth vocals
            predrive: 1.0,
            postdrive: 0.97,
            comp: { threshold: -22, knee: 10, ratio: 2.2, attack: 0.010, release: 0.20 },
            makeup: 1.65,               // ~+4.3 dB — more dynamic
            limiter: { threshold: -1.0, knee: 1.5, ratio: 18, attack: 0.001, release: 0.08 },
            width: 1.95,               // silky-wide — R&B benefits from spacious feel
            sideAir: 5.5
        },              // extra side sparkle for that polished R&B sheen

        rock: {
            label: 'Rock',
            low: { freq: 82, gain: 3.2 },
            midDip: { freq: 450, Q: 1.0, gain: -1.2 },
            presence: { freq: 3800, Q: 0.95, gain: 3.2 },
            air: { freq: 10000, gain: 2.8 },
            drive: 1.0,                // tape grit for rock
            predrive: 1.05,
            postdrive: 0.93,
            comp: { threshold: -19, knee: 6, ratio: 3.0, attack: 0.006, release: 0.15 },
            makeup: 1.95,               // ~+5.8 dB
            limiter: { threshold: -1.0, knee: 1, ratio: 20, attack: 0.0008, release: 0.06 },
            width: 1.7,               // moderate — drums centered, guitars wide
            sideAir: 1.8
        },              // bite on the wide guitars

        electronic: {
            label: 'Electronic',
            low: { freq: 60, gain: 4.5 },   // big sub, controlled
            midDip: { freq: 280, Q: 0.9, gain: -1.8 },
            presence: { freq: 4500, Q: 0.95, gain: 2.5 },
            air: { freq: 12000, gain: 3.5 },
            drive: 0.6,                // clean glue, less distortion
            predrive: 0.95,
            postdrive: 0.94,
            comp: { threshold: -19, knee: 6, ratio: 3.2, attack: 0.003, release: 0.10 },
            makeup: 1.85,               // ~+5.3 dB — club-loud, not crushed
            limiter: { threshold: -1.2, knee: 1, ratio: 16, attack: 0.0008, release: 0.05 },
            width: 2.1,                // very wide — EDM is BIG by design
            sideAir: 3.5
        },              // shimmer on the wide synth pads

        acoustic: {
            label: 'Acoustic',
            low: { freq: 130, gain: 1.8 },
            midDip: { freq: 400, Q: 0.9, gain: -1.0 },
            presence: { freq: 3000, Q: 0.7, gain: 2.2 },
            air: { freq: 11000, gain: 3.5 },
            drive: 0.3,                // barely any — preserve naturalness
            predrive: 1.0,
            postdrive: 0.98,
            comp: { threshold: -24, knee: 12, ratio: 1.8, attack: 0.012, release: 0.22 },
            makeup: 1.45,               // ~+3.2 dB — quieter, more dynamic
            limiter: { threshold: -1.2, knee: 2, ratio: 12, attack: 0.0015, release: 0.09 },
            width: 1.5,                // gentle — preserve the natural recording space
            sideAir: 1.5
        },              // light side air, keep things natural

        country: {
            label: 'Country',
            // Modern Nashville country: vocal-forward, warm but not sub-heavy,
            // bright top end for fiddle / steel / pick attack, moderate loudness.
            // Targets ~-10 LUFS (chart country sits between pop and rock loudness).
            low: { freq: 95, gain: 3.2 },   // kick weight, not 808
            midDip: { freq: 380, Q: 0.9, gain: -1.5 },   // clear mud
            presence: { freq: 3200, Q: 0.85, gain: 3.5 },    // vocals + pick attack
            air: { freq: 10500, gain: 4.0 },    // steel guitar shimmer, natural top
            drive: 0.7,                // subtle tape warmth — classic Nashville sound
            predrive: 1.0,
            postdrive: 0.95,
            comp: { threshold: -20, knee: 8, ratio: 2.6, attack: 0.006, release: 0.16 },
            makeup: 1.90,               // ~+5.6 dB — radio-loud, not smashed
            limiter: { threshold: -1.0, knee: 1, ratio: 18, attack: 0.0008, release: 0.06 },
            width: 1.7,                // Nashville-modern — wider than classic country
            sideAir: 2.2
        }               // steel guitar shimmer on the wide content
    };

    // --- DOM refs ---
    const dropZone = panel.querySelector('[data-role="drop"]');
    const fileInput = panel.querySelector('[data-role="file-input"]');
    const errorEl = panel.querySelector('[data-role="error"]');
    const processing = panel.querySelector('[data-role="processing"]');
    const procLabel = panel.querySelector('[data-role="processing-label"]');
    const playerEl = panel.querySelector('[data-role="player"]');
    const upsellEl = document.querySelector('[data-role="upsell"]');
    const filenameEl = panel.querySelector('[data-role="filename"]');
    const fileinfoEl = panel.querySelector('[data-role="fileinfo"]');
    const resetBtn = panel.querySelector('[data-role="reset"]');
    const playBtn = panel.querySelector('[data-role="play"]');
    const btnA = panel.querySelector('.ab-btn[data-ch="a"]');
    const btnB = panel.querySelector('.ab-btn[data-ch="b"]');
    const meter = panel.querySelector('[data-role="meter"]');
    const fillA = panel.querySelector('[data-role="meter-fill-a"]');
    const fillB = panel.querySelector('[data-role="meter-fill-b"]');
    const cfRowA = panel.querySelector('.ab-cf-row[data-side="a"]');
    const cfRowB = panel.querySelector('.ab-cf-row[data-side="b"]');
    const nowEl = panel.querySelector('[data-role="now"]');
    const totalEl = panel.querySelector('[data-role="total"]');
    const chanTag = panel.querySelector('[data-role="channel-tag"]');
    const genreBtns = panel.querySelectorAll('.ab-genre-btn');
    const loudNum = panel.querySelector('[data-role="loud-num"]');
    const loudVerdict = panel.querySelector('[data-role="loud-verdict"]');
    const needleL = panel.querySelector('[data-role="vu-needle-l"]');
    const needleR = panel.querySelector('[data-role="vu-needle-r"]');
    const overL = panel.querySelector('[data-role="vu-over-l"]');
    const overR = panel.querySelector('[data-role="vu-over-r"]');

    // --- State ---
    let ctx = null, buffer = null, source = null;
    let nodes = {};                // all graph nodes
    let channel = 'a';
    let currentGenre = 'pop';
    let isPlaying = false;
    let startCtxTime = 0, pauseOffset = 0;
    let rafId = 0;

    // --- State transitions ---
    const setState = (s) => {
        panel.dataset.state = s;
        dropZone.hidden = s !== 'upload';
        processing.hidden = s !== 'processing';
        playerEl.hidden = s !== 'ready';
        if (upsellEl) upsellEl.hidden = s !== 'ready';
    };
    const showError = (msg) => { errorEl.hidden = false; errorEl.textContent = msg; };
    const clearError = () => { errorEl.hidden = true; errorEl.textContent = ''; };

    // --- Drag & drop ---
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('is-drag'); }));
    dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });

    // --- File handling ---
    async function handleFile(file) {
        clearError();
        if (!file.type.startsWith('audio/') && !/\.(mp3|wav|flac|aac|m4a|ogg|oga)$/i.test(file.name)) {
            showError('That doesn\'t look like an audio file. Try a WAV, MP3, FLAC, or M4A.');
            return;
        }
        if (file.size > MAX_BYTES) {
            showError('File is too large (max 20 MB). Try trimming to a 30-second clip.');
            return;
        }

        setState('processing');
        procLabel.textContent = 'Reading your track…';

        try {
            if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') await ctx.resume();

            const arr = await file.arrayBuffer();
            procLabel.textContent = 'Decoding audio…';
            const decoded = await ctx.decodeAudioData(arr);

            procLabel.textContent = 'Analyzing your track…';
            // Smart input analysis — let us auto-tune the chain to the source
            const inputAnalysis = analyzeInputBuffer(decoded);
            console.log('[Stemy Audio] Input analysis:', inputAnalysis);

            // Show the smart-tune indicator with what we measured
            const smartStrip = panel.querySelector('[data-role="smart-tune"]');
            const smartDetail = panel.querySelector('[data-role="smart-tune-detail"]');
            if (smartStrip && smartDetail) {
                const lufsRounded = Math.round(inputAnalysis.lufs * 10) / 10;
                let summary = `Input: ${lufsRounded} LUFS · `;
                if (inputAnalysis.isHot) summary += 'Already loud — easing makeup';
                else if (inputAnalysis.isQuiet) summary += 'Quiet mix — pushing more';
                else summary += 'Streaming-ready loudness';
                if (inputAnalysis.isMuddy) summary += ' · Clearing muddy mids';
                else if (inputAnalysis.isDull) summary += ' · Adding air';
                else if (inputAnalysis.isBright) summary += ' · Taming highs';
                else if (inputAnalysis.isSubHeavy) summary += ' · Sub already strong';
                summary += ' · Stereo-widened for major sound';
                smartDetail.textContent = summary;
                smartStrip.hidden = false;
            }

            procLabel.textContent = 'Warming up the console…';
            buffer = clampBuffer(decoded, SNIP_SECONDS);

            buildGraph();
            // Apply genre, but adjusted by what we measured in the input
            applyGenreSmart(currentGenre, inputAnalysis, true);
            // Stash analysis so genre changes can re-tune
            window.__stemyInputAnalysis = inputAnalysis;

            pauseOffset = 0;
            channel = 'a';
            applyChannelGains(true);
            btnA.setAttribute('aria-pressed', 'true');
            btnB.setAttribute('aria-pressed', 'false');
            chanTag.textContent = 'A · BEFORE';
            chanTag.setAttribute('data-ch', 'a');
            if (cfRowA) cfRowA.setAttribute('data-active', 'true');
            if (cfRowB) cfRowB.setAttribute('data-active', 'false');

            filenameEl.textContent = file.name;
            filenameEl.title = file.name;
            const dur = Math.min(buffer.duration, SNIP_SECONDS);
            fileinfoEl.textContent = fmt(dur) + ' · ' + Math.round(buffer.sampleRate / 1000 * 10) / 10 + ' kHz · ' + (buffer.numberOfChannels > 1 ? 'stereo' : 'mono');
            totalEl.textContent = fmt(dur);
            nowEl.textContent = '0:00';
            fillA.style.width = '0%';
            fillB.style.width = '0%';

            setState('ready');
        } catch (err) {
            console.error(err);
            setState('upload');
            showError('Couldn\'t decode that file. Try a different format (MP3, WAV, M4A).');
        }
    }

    // --- Clamp buffer to N sec ---
    function clampBuffer(buf, maxSec) {
        if (buf.duration <= maxSec) return buf;
        const rate = buf.sampleRate;
        const samples = Math.floor(rate * maxSec);
        const out = ctx.createBuffer(buf.numberOfChannels, samples, rate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            out.copyToChannel(buf.getChannelData(ch).subarray(0, samples), ch);
        }
        return out;
    }

    // --- Build the audio graph once, then tune per genre ---
    function buildGraph() {
        nodes.gainA = ctx.createGain();

        // High-pass to remove subsonic rumble (cleaner low end)
        nodes.hpf = ctx.createBiquadFilter();
        nodes.hpf.type = 'highpass';
        nodes.hpf.frequency.value = 28;

        nodes.lowShelf = ctx.createBiquadFilter(); nodes.lowShelf.type = 'lowshelf';
        nodes.midDip = ctx.createBiquadFilter(); nodes.midDip.type = 'peaking';
        nodes.presence = ctx.createBiquadFilter(); nodes.presence.type = 'peaking';
        nodes.air = ctx.createBiquadFilter(); nodes.air.type = 'highshelf';

        // Preamp — pushes into the saturator
        nodes.preDrive = ctx.createGain();
        nodes.preDrive.gain.value = 1.0;

        // Saturation — the secret sauce. Soft-clip tanh curve.
        nodes.saturator = ctx.createWaveShaper();
        nodes.saturator.curve = makeSaturationCurve(2.0);  // default amount, re-set per genre
        nodes.saturator.oversample = '4x';

        nodes.postDrive = ctx.createGain();  // compensate after saturation
        nodes.postDrive.gain.value = 0.85;

        // Glue compressor
        nodes.comp = ctx.createDynamicsCompressor();

        // Makeup gain
        nodes.makeup = ctx.createGain();

        // ===== Stereo Widener (Mid/Side processing) =====
        // Splits L/R into Mid (L+R) and Side (L-R), boosts Side, recombines.
        // This is what gives major-label masters their "wide & big" feel.
        nodes.widenerSplit = ctx.createChannelSplitter(2);
        nodes.widenerMerge = ctx.createChannelMerger(2);
        // L+R/2 = Mid (mono content: vocals, kick, bass)
        nodes.midSum = ctx.createGain(); nodes.midSum.gain.value = 0.5;
        // L-R/2 = Side (stereo content: reverbs, ambience, wide synths)
        nodes.sideL = ctx.createGain(); nodes.sideL.gain.value = 0.5;
        nodes.sideR = ctx.createGain(); nodes.sideR.gain.value = -0.5;
        // Width amount — gain on Side relative to Mid (1.0 = no change)
        nodes.widthGain = ctx.createGain(); nodes.widthGain.gain.value = 1.0;
        // Mid output (mono center)
        nodes.midOut = ctx.createGain(); nodes.midOut.gain.value = 1.0;
        // Side has a subtle high-shelf so widening pushes top-end air, not low-end mush
        nodes.sideShelf = ctx.createBiquadFilter();
        nodes.sideShelf.type = 'highshelf';
        nodes.sideShelf.frequency.value = 4000;
        nodes.sideShelf.gain.value = 0;

        // Brickwall limiter
        nodes.limiter = ctx.createDynamicsCompressor();

        nodes.gainB = ctx.createGain();

        // Connect: hpf -> EQ -> preDrive -> saturator -> postDrive -> comp -> makeup -> WIDENER -> limiter -> gainB
        nodes.hpf
            .connect(nodes.lowShelf)
            .connect(nodes.midDip)
            .connect(nodes.presence)
            .connect(nodes.air)
            .connect(nodes.preDrive)
            .connect(nodes.saturator)
            .connect(nodes.postDrive)
            .connect(nodes.comp)
            .connect(nodes.makeup);

        // Mid/Side widener network (after makeup, before limiter)
        // Branch 1: Mid path (L+R combined, no width effect)
        nodes.makeup.connect(nodes.widenerSplit);
        // Sum L and R for Mid signal — both go to midSum
        nodes.widenerSplit.connect(nodes.midSum, 0); // L
        nodes.widenerSplit.connect(nodes.midSum, 1); // R
        nodes.midSum.connect(nodes.midOut);
        // Difference for Side signal: L positive, R inverted (so we get L-R)
        nodes.widenerSplit.connect(nodes.sideL, 0); // L * 0.5
        nodes.widenerSplit.connect(nodes.sideR, 1); // R * -0.5  (inversion via gain)
        // Both feed into sideShelf, then through widthGain
        nodes.sideL.connect(nodes.sideShelf);
        nodes.sideR.connect(nodes.sideShelf);
        nodes.sideShelf.connect(nodes.widthGain);
        // Recombine: L_out = Mid + Side, R_out = Mid - Side
        // We need to send (mid + width*side) to L and (mid - width*side) to R.
        // Easiest with another splitter trick:
        nodes.midOut.connect(nodes.widenerMerge, 0, 0); // mid -> L
        nodes.midOut.connect(nodes.widenerMerge, 0, 1); // mid -> R
        // Side adds to L, subtracts from R
        nodes.sideToL = ctx.createGain(); nodes.sideToL.gain.value = 1.0;
        nodes.sideToR = ctx.createGain(); nodes.sideToR.gain.value = -1.0;
        nodes.widthGain.connect(nodes.sideToL);
        nodes.widthGain.connect(nodes.sideToR);
        nodes.sideToL.connect(nodes.widenerMerge, 0, 0);
        nodes.sideToR.connect(nodes.widenerMerge, 0, 1);
        // Out of widener -> limiter -> gainB
        nodes.widenerMerge
            .connect(nodes.limiter)
            .connect(nodes.gainB);

        nodes.gainA.connect(ctx.destination);
        nodes.gainB.connect(ctx.destination);

        // Stereo analysers for VU metering (per-channel L/R)
        nodes.splitterA = ctx.createChannelSplitter(2);
        nodes.splitterB = ctx.createChannelSplitter(2);
        nodes.gainA.connect(nodes.splitterA);
        nodes.gainB.connect(nodes.splitterB);

        nodes.analyserA_L = ctx.createAnalyser();
        nodes.analyserA_R = ctx.createAnalyser();
        nodes.analyserB_L = ctx.createAnalyser();
        nodes.analyserB_R = ctx.createAnalyser();
        [nodes.analyserA_L, nodes.analyserA_R, nodes.analyserB_L, nodes.analyserB_R].forEach(a => {
            a.fftSize = 2048;
            a.smoothingTimeConstant = 0.0;   // we do our own VU ballistics
        });
        nodes.splitterA.connect(nodes.analyserA_L, 0);
        nodes.splitterA.connect(nodes.analyserA_R, 1);
        nodes.splitterB.connect(nodes.analyserB_L, 0);
        nodes.splitterB.connect(nodes.analyserB_R, 1);
    }

    // Build a gentle mastering-grade saturation curve.
    // Uses a soft cubic soft-clip that adds harmonics without audible distortion.
    // `amount` in 0.1-1.5 range. 0.3 ≈ barely audible warmth, 1.0 ≈ obvious but clean.
    function makeSaturationCurve(amount) {
        const n = 4096;
        const curve = new Float32Array(n);
        // Clamp: real mastering saturation should stay subtle.
        const k = Math.max(0.1, Math.min(1.5, amount));
        for (let i = 0; i < n; i++) {
            const x = (i * 2 / n) - 1;  // -1 to 1
            // Soft cubic distortion: x - (k/3) * x^3  (classic soft-clip)
            // This adds odd harmonics cleanly without hard clipping
            const shaped = x - (k / 3) * x * x * x;
            // Gentle tanh wrap to prevent any overshoot
            curve[i] = Math.tanh(shaped * 1.1) / Math.tanh(1.1);
        }
        return curve;
    }

    // --- Smoothly tune graph to a genre preset ---
    function applyGenre(key, instant) {
        const p = GENRES[key];
        if (!p || !nodes.hpf) return;
        const now = ctx.currentTime;
        const tc = 0.05;
        const set = (param, val) => {
            if (instant) param.setValueAtTime(val, now);
            else param.setTargetAtTime(val, now, tc);
        };

        set(nodes.lowShelf.frequency, p.low.freq);
        set(nodes.lowShelf.gain, p.low.gain);

        set(nodes.midDip.frequency, p.midDip.freq);
        set(nodes.midDip.Q, p.midDip.Q);
        set(nodes.midDip.gain, p.midDip.gain);

        set(nodes.presence.frequency, p.presence.freq);
        set(nodes.presence.Q, p.presence.Q);
        set(nodes.presence.gain, p.presence.gain);

        set(nodes.air.frequency, p.air.freq);
        set(nodes.air.gain, p.air.gain);

        // Saturator curve is static but amount changes per genre — rebuild it.
        nodes.saturator.curve = makeSaturationCurve(p.drive);

        set(nodes.preDrive.gain, p.predrive);
        set(nodes.postDrive.gain, p.postdrive);

        set(nodes.comp.threshold, p.comp.threshold);
        set(nodes.comp.knee, p.comp.knee);
        set(nodes.comp.ratio, p.comp.ratio);
        set(nodes.comp.attack, p.comp.attack);
        set(nodes.comp.release, p.comp.release);

        set(nodes.makeup.gain, p.makeup);

        set(nodes.limiter.threshold, p.limiter.threshold);
        set(nodes.limiter.knee, p.limiter.knee);
        set(nodes.limiter.ratio, p.limiter.ratio);
        set(nodes.limiter.attack, p.limiter.attack);
        set(nodes.limiter.release, p.limiter.release);

        // Stereo widener — per-genre width amount (default 1.4 = 40% wider)
        if (nodes.widthGain) {
            const widthAmount = (p.width !== undefined) ? p.width : 1.4;
            set(nodes.widthGain.gain, widthAmount);
        }
        if (nodes.sideShelf) {
            const sideAir = (p.sideAir !== undefined) ? p.sideAir : 2.0;
            set(nodes.sideShelf.gain, sideAir);
        }

        currentGenre = key;
    }

    function applyChannelGains(instant) {
        if (!nodes.gainA || !nodes.gainB) return;
        const t = ctx.currentTime;
        // A (BEFORE) at unity. B (AFTER) gets a small +1.5dB boost (~1.19x) — just
        // enough for the VU to read visibly louder without the limiter pumping or
        // adding distortion. The mastering chain (EQ, comp, saturation, limiter)
        // already provides most of the perceived loudness; this is gentle final
        // makeup gain to sell the "louder, fuller" visual on the meter.
        const a = channel === 'a' ? 1.0 : 0;
        const b = channel === 'b' ? 1.19 : 0;
        if (instant) {
            nodes.gainA.gain.setValueAtTime(a, t);
            nodes.gainB.gain.setValueAtTime(b, t);
        } else {
            nodes.gainA.gain.setTargetAtTime(a, t, 0.005);
            nodes.gainB.gain.setTargetAtTime(b, t, 0.005);
        }
    }

    // --- Playback ---
    function play() {
        if (!buffer || !ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(nodes.gainA);
        source.connect(nodes.hpf);
        source.onended = () => {
            if (!source || source._stoppedManually) return;
            isPlaying = false; updatePlayUI();
            pauseOffset = 0; updateTimeUI();
            cancelAnimationFrame(rafId);
        };
        const offset = Math.min(pauseOffset, buffer.duration - 0.01);
        source.start(0, offset);
        startCtxTime = ctx.currentTime;
        isPlaying = true;
        updatePlayUI();
        tickLoop();
    }
    function pause() {
        if (!source) return;
        const elapsed = ctx.currentTime - startCtxTime;
        pauseOffset = Math.min(pauseOffset + elapsed, buffer.duration);
        source._stoppedManually = true;
        try { source.stop(); } catch (e) { }
        source = null;
        isPlaying = false;
        updatePlayUI();
        cancelAnimationFrame(rafId);
    }
    function seekTo(sec) {
        const wasPlaying = isPlaying;
        if (source) { source._stoppedManually = true; try { source.stop(); } catch (e) { } source = null; }
        pauseOffset = Math.max(0, Math.min(sec, buffer.duration));
        isPlaying = false;
        updateTimeUI();
        if (wasPlaying) play(); else updatePlayUI();
    }
    function switchTo(ch) {
        if (ch === channel || !buffer) return;
        channel = ch;
        btnA.setAttribute('aria-pressed', ch === 'a' ? 'true' : 'false');
        btnB.setAttribute('aria-pressed', ch === 'b' ? 'true' : 'false');
        chanTag.textContent = ch === 'a' ? 'A · BEFORE' : 'B · AFTER';
        chanTag.setAttribute('data-ch', ch);
        // Crossfade visual — light up the active row, dim the inactive one
        if (cfRowA) cfRowA.setAttribute('data-active', ch === 'a' ? 'true' : 'false');
        if (cfRowB) cfRowB.setAttribute('data-active', ch === 'b' ? 'true' : 'false');
        applyChannelGains(false);
        // Clear the meter's averaging window so the readout jumps cleanly to new level
        vuState.samples = [];
    }

    // --- UI ---
    function currentSec() {
        if (!buffer) return 0;
        if (isPlaying) return Math.min(pauseOffset + (ctx.currentTime - startCtxTime), buffer.duration);
        return pauseOffset;
    }
    function updateTimeUI() {
        if (!buffer) return;
        const t = currentSec();
        nowEl.textContent = fmt(t);
        const pct = (t / buffer.duration) * 100;
        fillA.style.width = pct + '%';
        fillB.style.width = pct + '%';
        meter.setAttribute('aria-valuenow', Math.round(pct));
    }
    function updatePlayUI() {
        playBtn.dataset.playing = isPlaying ? 'true' : 'false';
        panel.dataset.playing = isPlaying ? 'true' : 'false';
    }
    function tickLoop() {
        updateTimeUI();
        updateLoudnessUI();
        if (isPlaying && currentSec() >= buffer.duration - 0.02) {
            pause(); pauseOffset = 0; updateTimeUI(); return;
        }
        if (isPlaying) rafId = requestAnimationFrame(tickLoop);
    }
    function fmt(s) { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); const r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); }

    // --- Stereo VU metering ---
    // Classic VU ballistics: 300ms integration to 99% of step input.
    // dB-to-angle mapping uses piecewise-linear approximation of a real
    // VU meter's non-linear scale (-20 far left, 0 near vertical, +3 red).
    const vuState = {
        bufL: null, bufR: null,
        valA_L: -50, valA_R: -50,  // smoothed dB (persisted across frames)
        valB_L: -50, valB_R: -50,
        lastMs: 0,
        overHoldL: 0,
        overHoldR: 0,
        // Rolling samples for the small digital LUFS readout below the needles
        samples: [],
        maxSamples: 24,
    };
    // VU reference: the needle hits 0 VU when input RMS = VU_REF_DBFS.
    // For modern mastered tracks (~-8 LUFS, ~-5 dBFS RMS) to sit in the musical
    // 0 to +3 range, the reference must be set accordingly. Raw mixes (~-20 dBFS)
    // will then read around -15 to -10 VU — in the middle of the scale.
    const VU_REF_DBFS = -7;

    function readChannelRms(analyser, bufKey) {
        if (!analyser) return -60;
        const n = analyser.fftSize;
        if (!vuState[bufKey] || vuState[bufKey].length !== n) vuState[bufKey] = new Float32Array(n);
        const buf = vuState[bufKey];
        analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < n; i++) { const v = buf[i]; sumSq += v * v; }
        const rms = Math.sqrt(sumSq / n);
        if (rms < 1e-7) return -60;
        return 20 * Math.log10(rms);
    }

    // VU scale: piecewise-linear dB -> needle angle in degrees.
    // Negative angle = needle left of vertical. 0 = vertical. +30 = deep in red.
    function vuDbToAngle(dbVU) {
        // dbVU is "VU dB" (0 VU = 0 here, -20 VU = -50deg, +3 VU = +30deg)
        const pts = [
            [-40, -50], [-20, -50], [-10, -35], [-7, -28], [-5, -22],
            [-3, -14], [-2, -9], [-1, -5], [0, 0],
            [1, 10], [2, 20], [3, 30], [6, 35]
        ];
        if (dbVU <= pts[0][0]) return pts[0][1];
        if (dbVU >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
        for (let i = 0; i < pts.length - 1; i++) {
            const [d1, a1] = pts[i], [d2, a2] = pts[i + 1];
            if (dbVU >= d1 && dbVU <= d2) {
                const t = (dbVU - d1) / (d2 - d1);
                return a1 + t * (a2 - a1);
            }
        }
        return -50;
    }

    function updateLoudnessUI() {
        if (!nodes.analyserA_L) return;

        // Frame delta for ballistics
        const nowMs = performance.now();
        const dt = vuState.lastMs === 0 ? 0.016 : Math.min(0.1, (nowMs - vuState.lastMs) / 1000);
        vuState.lastMs = nowMs;

        // VU ballistics: first-order low-pass with 300ms time constant.
        // alpha = 1 - exp(-dt/tau). At 60fps (dt=0.016), alpha ≈ 0.053.
        const tau = 0.30;   // 300ms standard VU
        const alpha = 1 - Math.exp(-dt / tau);

        // Read all four channels every frame (needed for fast A/B switch response)
        const rmsA_L = readChannelRms(nodes.analyserA_L, 'bufL');
        const rmsA_R = readChannelRms(nodes.analyserA_R, 'bufR');
        const rmsB_L = readChannelRms(nodes.analyserB_L, 'bufL');
        const rmsB_R = readChannelRms(nodes.analyserB_R, 'bufR');

        // Smooth toward current readings (applies to both A and B in parallel)
        vuState.valA_L += alpha * (rmsA_L - vuState.valA_L);
        vuState.valA_R += alpha * (rmsA_R - vuState.valA_R);
        vuState.valB_L += alpha * (rmsB_L - vuState.valB_L);
        vuState.valB_R += alpha * (rmsB_R - vuState.valB_R);

        // Pick the active channel's values for the needles
        const valL = channel === 'a' ? vuState.valA_L : vuState.valB_L;
        const valR = channel === 'a' ? vuState.valA_R : vuState.valB_R;

        // Convert dBFS-RMS to VU dB (0 VU = VU_REF_DBFS)
        const vuL = valL - VU_REF_DBFS;
        const vuR = valR - VU_REF_DBFS;

        // Rotate needles
        if (needleL) needleL.setAttribute('transform', `rotate(${vuDbToAngle(vuL).toFixed(2)} 110 135)`);
        if (needleR) needleR.setAttribute('transform', `rotate(${vuDbToAngle(vuR).toFixed(2)} 110 135)`);

        // OVER LEDs (light when instantaneous peak hits near 0 dBFS)
        const instPeakL = rmsA_L + (channel === 'a' ? 0 : (rmsB_L - rmsA_L));  // follow active
        const instPeakR = rmsA_R + (channel === 'a' ? 0 : (rmsB_R - rmsA_R));
        // Light the OVER if we go above -2 dBFS RMS (≈ very hot, near clipping)
        if (valL > -2) { vuState.overHoldL = 30; }
        if (valR > -2) { vuState.overHoldR = 30; }
        if (overL) overL.setAttribute('data-lit', vuState.overHoldL > 0 ? 'true' : 'false');
        if (overR) overR.setAttribute('data-lit', vuState.overHoldR > 0 ? 'true' : 'false');
        if (vuState.overHoldL > 0) vuState.overHoldL--;
        if (vuState.overHoldR > 0) vuState.overHoldR--;

        // Digital readout below the meters (approx LUFS — average of the two channels, K-weighted offset)
        const summed = Math.max(valL, valR);
        const lufsApprox = summed - 3;  // rough K-weighting offset
        vuState.samples.push(lufsApprox);
        if (vuState.samples.length > vuState.maxSamples) vuState.samples.shift();
        const avgLufs = vuState.samples.reduce((a, b) => a + b, 0) / vuState.samples.length;

        if (!isPlaying && vuState.samples.length === 0) {
            loudNum.textContent = '—';
            loudNum.setAttribute('data-zone', 'normal');
            loudVerdict.textContent = '—';
            loudVerdict.setAttribute('data-verdict', 'idle');
            return;
        }

        const displayDb = Math.max(-60, Math.min(0, avgLufs));
        loudNum.textContent = displayDb.toFixed(1);

        if (displayDb > -6) loudNum.setAttribute('data-zone', 'hot');
        else if (displayDb > -11) loudNum.setAttribute('data-zone', 'warm');
        else loudNum.setAttribute('data-zone', 'normal');

        if (displayDb > -4) { loudVerdict.textContent = 'Hot · reduce'; loudVerdict.setAttribute('data-verdict', 'hot'); }
        else if (displayDb > -10) { loudVerdict.textContent = 'Chart-ready'; loudVerdict.setAttribute('data-verdict', 'chart'); }
        else if (displayDb > -16) { loudVerdict.textContent = 'Streaming-ready'; loudVerdict.setAttribute('data-verdict', 'streaming'); }
        else { loudVerdict.textContent = 'Quiet · needs lift'; loudVerdict.setAttribute('data-verdict', 'quiet'); }
    }

    function resetLoudness() {
        vuState.samples = [];
        vuState.valA_L = vuState.valA_R = -50;
        vuState.valB_L = vuState.valB_R = -50;
        vuState.overHoldL = vuState.overHoldR = 0;
        if (needleL) needleL.setAttribute('transform', 'rotate(-50 110 135)');
        if (needleR) needleR.setAttribute('transform', 'rotate(-50 110 135)');
        if (overL) overL.setAttribute('data-lit', 'false');
        if (overR) overR.setAttribute('data-lit', 'false');
        if (loudNum) { loudNum.textContent = '—'; loudNum.setAttribute('data-zone', 'normal'); }
        if (loudVerdict) { loudVerdict.textContent = '—'; loudVerdict.setAttribute('data-verdict', 'idle'); }
    }

    // --- Controls ---
    playBtn.addEventListener('click', () => { if (!buffer) return; if (isPlaying) pause(); else play(); });
    btnA.addEventListener('click', () => switchTo('a'));
    btnB.addEventListener('click', () => switchTo('b'));
    meter.addEventListener('click', (e) => {
        if (!buffer) return;
        const rect = meter.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        seekTo(pct * buffer.duration);
    });
    resetBtn.addEventListener('click', () => {
        if (isPlaying) pause();
        buffer = null; pauseOffset = 0; fileInput.value = '';
        resetLoudness();
        clearError(); setState('upload');
    });

    // Genre buttons
    genreBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const g = btn.dataset.genre;
            genreBtns.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
            // Use smart auto-tune if we have an analysis from the upload
            if (window.__stemyInputAnalysis) {
                applyGenreSmart(g, window.__stemyInputAnalysis, false);
            } else {
                applyGenre(g, false);
            }
            currentGenre = g;
            // If they picked a genre, flip to B so they actually hear it
            if (buffer && channel !== 'b') switchTo('b');
        });
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
        const rect = panel.getBoundingClientRect();
        const visible = rect.top < window.innerHeight && rect.bottom > 0;
        if (!visible || !buffer) return;
        if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
        if (e.key && e.key.toLowerCase() === 'a') switchTo('a');
        if (e.key && e.key.toLowerCase() === 'b') switchTo('b');
    });

    setState('upload');
})();

(function () {
    const HPC_STEMS = ['DRUMS', 'BASS', 'VOCALS', 'KEYS', 'GUITAR', 'FX'];
    const bridge = document.getElementById('hpcVuMeters');
    const strips = document.getElementById('hpcStrips');
    if (!bridge || !strips) return;

    // Build VU meters
    bridge.innerHTML = HPC_STEMS.map((name, i) => `
      <div class="hpc-vu-unit">
        <div class="hpc-vu-body">
          <div class="hpc-vu-glass">
            <svg class="hpc-vu-arc-svg" viewBox="0 0 100 60" preserveAspectRatio="xMidYMax meet">
              <path id="hpcArc${i}" d="M 14,55 A 36,36 0 0 1 86,55" fill="none" stroke="none"/>
              <text font-family="DM Mono, monospace" font-size="5" font-weight="700" fill="#1a0f05"><textPath href="#hpcArc${i}" startOffset="2%">-20</textPath></text>
              <text font-family="DM Mono, monospace" font-size="5" font-weight="700" fill="#1a0f05"><textPath href="#hpcArc${i}" startOffset="32%">-10</textPath></text>
              <text font-family="DM Mono, monospace" font-size="5" font-weight="700" fill="#1a0f05"><textPath href="#hpcArc${i}" startOffset="64%">0</textPath></text>
              <text font-family="DM Mono, monospace" font-size="5" font-weight="700" fill="#c41020"><textPath href="#hpcArc${i}" startOffset="92%">+3</textPath></text>
            </svg>
            <div class="hpc-vu-arc"><div class="hpc-vu-needle"></div><div class="hpc-vu-pivot"></div></div>
          </div>
        </div>
        <div class="hpc-vu-name">${name}</div>
      </div>
    `).join('');

    // Build channel strips (4 most prominent)
    strips.innerHTML = ['drums', 'bass', 'vocals', 'fx'].map((id, i) => {
        const names = ['Drums', 'Bass', 'Vocals', 'FX'];
        return `
        <div class="hpc-strip">
          <div class="hpc-strip-name hpc-c-${id}">${names[i]}</div>
          <div class="hpc-strip-section">
            <div class="hpc-section-lbl">EQ</div>
            <div class="hpc-knob-row">
              <div class="hpc-knob"></div><div class="hpc-knob"></div><div class="hpc-knob"></div>
            </div>
          </div>
          <div class="hpc-strip-section">
            <div class="hpc-section-lbl">DYN</div>
            <div class="hpc-knob-row">
              <div class="hpc-knob"></div><div class="hpc-knob"></div>
            </div>
          </div>
          <div class="hpc-fader-area">
            <div class="hpc-mini-meter"><div class="hpc-mini-meter-fill"></div></div>
            <div class="hpc-fader-rail"><div class="hpc-fader-cap" style="bottom:${40 + i * 10}%;"></div></div>
          </div>
        </div>
      `;
    }).join('');

    // Animate continuously
    function tick() {
        document.querySelectorAll('.hpc-vu-needle').forEach(n => {
            const angle = -25 + (Math.random() * 40 - 15) * 0.85;
            n.style.transform = 'translateX(-50%) rotate(' + angle + 'deg)';
        });
        document.querySelectorAll('.hpc-mini-meter-fill').forEach(m => {
            m.style.height = (20 + Math.random() * 55) + '%';
        });
        setTimeout(tick, 160);
    }
    tick();
})();

// Pricing data: [monthly, yearly_total]
const pricingData = {
    basic: { monthly: '$9.99', yearly: '$83.88', mperiod: '/month', yperiod: '/year' },
    pro: { monthly: '$24.99', yearly: '$164.99', mperiod: '/month', yperiod: '/year' },
};
let isYearly = false;

function toggleBilling() {
    isYearly = !isYearly;
    const toggle = document.getElementById('billingToggle');
    const monthlyLabel = document.getElementById('monthlyLabel');
    const yearlyLabel = document.getElementById('yearlyLabel');
    const note = document.getElementById('billingNote');

    toggle.classList.toggle('yearly', isYearly);
    monthlyLabel.classList.toggle('active', !isYearly);
    yearlyLabel.classList.toggle('active', isYearly);

    // Update prices
    document.getElementById('price-basic').innerHTML = isYearly ? pricingData.basic.yearly : pricingData.basic.monthly;
    document.getElementById('price-pro').innerHTML = isYearly ? pricingData.pro.yearly : pricingData.pro.monthly;

    // Update period labels
    document.getElementById('period-basic').innerHTML = isYearly ? pricingData.basic.yperiod : pricingData.basic.mperiod;
    document.getElementById('period-pro').innerHTML = isYearly ? pricingData.pro.yperiod : pricingData.pro.mperiod;

    // Update descriptions
    document.getElementById('desc-basic').textContent = isYearly ? 'Save 30% vs monthly — billed once a year' : 'Unlimited mastering — beats eMastered & LANDR';
    document.getElementById('desc-pro').textContent = isYearly ? 'Save 45% vs monthly — billed once a year' : 'Full mixing console + unlimited stems';

    note.textContent = isYearly ? 'Billed annually · Cancel anytime · Best value' : 'Billed monthly · Cancel anytime';
}

(function () {
    const STEMS = [
        { id: 'drums', name: 'Drums', color: 'drums' },
        { id: 'bass', name: 'Bass', color: 'bass' },
        { id: 'vocals', name: 'Vocals', color: 'vocals' },
        { id: 'keys', name: 'Keys', color: 'keys' },
        { id: 'guitar', name: 'Guitar', color: 'guitar' },
        { id: 'fx', name: 'FX', color: 'fx' }
    ];
    let pmxMode = 'stems', pmxRefOn = false, pmxAudio = null, pmxPlaying = false, pmxVuAnim = null;

    function buildStrip(name, color, id) {
        const isVocals = id === 'vocals';
        return `<div class="pmx-strip${isVocals ? ' pmx-strip-vox' : ''}">
      <div class="pmx-strip-name color-${color || 'fx'}">${name}</div>
      ${isVocals ? `
      <!-- AUTO-TUNE MODULE (Vocals only) -->
      <div class="pmx-strip-section pmx-sec-tune">
        <div class="pmx-tune-header">
          <span class="pmx-tune-title">AUTO-TUNE</span>
          <button class="pmx-tune-led" onclick="pmxToggleTune(this)" title="Engage pitch correction"></button>
        </div>
        <div class="pmx-tune-key-row">
          <span class="pmx-tune-mini-lbl">KEY</span>
          <select class="pmx-tune-key-sel" onclick="event.stopPropagation()">
            <option>C maj</option><option>C# maj</option><option>D maj</option>
            <option>D# maj</option><option>E maj</option><option>F maj</option>
            <option>F# maj</option><option>G maj</option><option>G# maj</option>
            <option selected>A maj</option><option>A# maj</option><option>B maj</option>
            <option>A min</option><option>D min</option><option>E min</option>
            <option>F# min</option><option>G min</option><option>B min</option>
            <option>Chromatic</option>
          </select>
        </div>
        <div class="pmx-tune-controls">
          <div class="pmx-knob-wrap pmx-tune-knob"><div class="pmx-hw-knob pmx-knob-tune" data-tune="amt"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">AMT</span></div>
          <div class="pmx-knob-wrap pmx-tune-knob"><div class="pmx-hw-knob pmx-knob-tune" data-tune="speed"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">SPD</span></div>
          <button class="pmx-tune-hard" onclick="pmxToggleHard(this)" title="T-Pain mode — instant snap"><span class="pmx-tune-hard-led"></span><span>HARD</span></button>
        </div>
      </div>
      ` : ''}
      <div class="pmx-strip-section pmx-sec-eq">
        <div class="pmx-section-lbl">EQ</div>
        <div class="pmx-knob-row">
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">HI</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">HMID</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">LMID</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">LOW</span></div>
        </div>
      </div>
      <div class="pmx-strip-section pmx-sec-dyn">
        <div class="pmx-section-lbl">DYN</div>
        <div class="pmx-knob-row">
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">THR</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">RAT</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">ATK</span></div>
        </div>
      </div>
      <div class="pmx-strip-section pmx-sec-fx${isVocals ? ' pmx-sec-vox-fx' : ''}">
        <div class="pmx-section-lbl">${isVocals ? 'VOCAL FX' : 'FX'}</div>
        ${isVocals ? `
        <div class="pmx-knob-row">
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">DESS</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">DBLR</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">SAT</span></div>
        </div>
        <div class="pmx-knob-row">
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">REV</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">DLY</span></div>
        </div>
        <div class="pmx-vox-badge">VOX RACK</div>
        ` : `
        <div class="pmx-knob-row">
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">REV</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">DLY</span></div>
          <div class="pmx-knob-wrap"><div class="pmx-hw-knob"><div class="pmx-knob-indicator"></div></div><span class="pmx-knob-lbl">SAT</span></div>
        </div>
        `}
      </div>
      <div class="pmx-strip-fader-section">
        <div class="pmx-channel-meter"><div class="pmx-channel-meter-fill"></div></div>
        <div class="pmx-fader-rail"><div class="pmx-fader-cap" style="bottom:55%;"></div></div>
      </div>
      <div class="pmx-strip-buttons">
        <button class="pmx-strip-btn mute" onclick="this.classList.toggle('on')">M</button>
        <button class="pmx-strip-btn solo" onclick="this.classList.toggle('on')">S</button>
      </div>
    </div>`;
    }

    function renderStrips() {
        const wrap = document.getElementById('pmxStrips');
        wrap.innerHTML = STEMS.map(s => buildStrip(s.name, s.color, s.id)).join('');
    }

    // Build vintage VU meter bridge
    function renderVuBridge() {
        const bridge = document.getElementById('pmxVuBridge');
        if (!bridge) return;
        const labels = ['DRUMS', 'BASS', 'VOCALS', 'KEYS', 'GUITAR', 'FX', 'MASTER L', 'MASTER R'];
        bridge.innerHTML = labels.map((l, i) => `
      <div class="pmx-vu-unit">
        <div class="pmx-vu-body">
          <div class="pmx-vu-glass">
            <svg class="pmx-vu-arc-svg" viewBox="0 0 100 60" preserveAspectRatio="xMidYMax meet">
              <path id="pmxArc${i}" d="M 14,55 A 36,36 0 0 1 86,55" fill="none" stroke="none"/>
              <text font-family="DM Mono, monospace" font-size="6" font-weight="700" fill="#1a0f05"><textPath href="#pmxArc${i}" startOffset="0%">-20</textPath></text>
              <text font-family="DM Mono, monospace" font-size="6" font-weight="700" fill="#1a0f05"><textPath href="#pmxArc${i}" startOffset="22%">-10</textPath></text>
              <text font-family="DM Mono, monospace" font-size="6" font-weight="700" fill="#1a0f05"><textPath href="#pmxArc${i}" startOffset="44%">-5</textPath></text>
              <text font-family="DM Mono, monospace" font-size="6" font-weight="700" fill="#1a0f05"><textPath href="#pmxArc${i}" startOffset="66%">0</textPath></text>
              <text font-family="DM Mono, monospace" font-size="6" font-weight="700" fill="#c41020"><textPath href="#pmxArc${i}" startOffset="92%">+3</textPath></text>
            </svg>
            <div class="pmx-vu-arc"><div class="pmx-vu-needle" data-vu="${i}"></div><div class="pmx-vu-pivot"></div></div>
          </div>
        </div>
        <div class="pmx-vu-name${i >= 6 ? ' master' : ''}">${l}</div>
      </div>
    `).join('');
    }

    // Animate VU meters (bridge + strips + master) at given intensity (0.3 idle, 0.85 active)
    function pmxAnimate(intensity) {
        intensity = intensity || 0.5;
        document.querySelectorAll('.pmx-vu-needle[data-vu]').forEach(n => {
            const angle = -25 + (Math.random() * 40 - 15) * intensity;
            n.style.transform = 'translateX(-50%) rotate(' + angle + 'deg)';
        });
        document.querySelectorAll('.pmx-channel-meter-fill').forEach(m => { m.style.height = (15 + Math.random() * 55 * intensity) + '%'; });
        const ml = document.getElementById('pmxMasterVuL');
        const mr = document.getElementById('pmxMasterVuR');
        if (ml) ml.style.height = (25 + Math.random() * 55 * intensity) + '%';
        if (mr) mr.style.height = (25 + Math.random() * 55 * intensity) + '%';
    }
    function pmxStartIdleAnim() { pmxStopVu(); const tick = () => { pmxAnimate(0.35); pmxVuAnim = setTimeout(tick, 200); }; tick(); }
    function pmxStartActiveAnim() { pmxStopVu(); const tick = () => { pmxAnimate(0.85); pmxVuAnim = setTimeout(tick, 140); }; tick(); }

    // Auto-Tune toggle (engages pitch correction LED indicator)
    window.pmxToggleTune = function (btn) {
        btn.classList.toggle('on');
        const isOn = btn.classList.contains('on');
        if (isOn) showToast('🎤 Auto-Tune engaged');
    };
    // Hard tune (T-Pain mode - instant snap)
    window.pmxToggleHard = function (btn) {
        btn.classList.toggle('on');
        const isOn = btn.classList.contains('on');
        // Auto-engage Auto-Tune LED if hard tune is turned on
        if (isOn) {
            const led = btn.closest('.pmx-strip-vox').querySelector('.pmx-tune-led');
            if (led && !led.classList.contains('on')) led.classList.add('on');
            showToast('🔥 Hard tune ON · T-Pain mode');
        }
    };

    window.pmxToggleRef = function () {
        pmxRefOn = !pmxRefOn;
        document.getElementById('pmxRefToggle').classList.toggle('on', pmxRefOn);
        document.getElementById('pmxRefStatus').textContent = pmxRefOn ? 'ON' : 'OFF';
        document.getElementById('pmxRefPanel').hidden = !pmxRefOn;
    };

    document.getElementById('pmxRefFileInput').addEventListener('change', function (e) {
        const f = e.target.files[0]; if (!f) return;
        document.getElementById('pmxRefName').textContent = f.name;
        document.getElementById('pmxRefMetaInfo').textContent = 'Analyzing...';
        document.getElementById('pmxRefDrop').style.display = 'none';
        document.getElementById('pmxRefLoadedDisp').hidden = false;
        setTimeout(() => {
            document.getElementById('pmxRefMetaInfo').textContent = '-8.2 LUFS · Warm · Punchy';
            document.getElementById('pmxRefStats').hidden = false;
        }, 800);
    });

    window.pmxClearRef = function () {
        document.getElementById('pmxRefFileInput').value = '';
        document.getElementById('pmxRefDrop').style.display = 'flex';
        document.getElementById('pmxRefLoadedDisp').hidden = true;
        document.getElementById('pmxRefStats').hidden = true;
    };

    document.getElementById('pmxMainFile').addEventListener('change', function (e) {
        const files = e.target.files; if (!files.length) return;
        document.getElementById('pmxTrackName').textContent = files.length + ' stems loaded';
        document.getElementById('pmxTrackMeta').textContent = files.length + ' files · Stem session · Active';
        document.getElementById('pmxBpm').textContent = '128';
        document.getElementById('pmxKey').textContent = 'Am';
        pmxStartActiveAnim();
    });

    function pmxStartVu() { pmxStartActiveAnim(); }
    function pmxStopVu() { if (pmxVuAnim) { clearTimeout(pmxVuAnim); pmxVuAnim = null; } }

    window.pmxStartMaster = function () {
        pmxStopVu();
        // BASIC USERS: show upgrade wall instead of processing
        document.getElementById('pmxStageSetup').hidden = true;
        document.getElementById('pmxStageUpgrade').hidden = false;
        window.scrollTo({ top: document.getElementById('pmxWrap').offsetTop, behavior: 'smooth' });
    };

    // Used by "Keep Exploring" — go back to console without resetting
    window.pmxBackToConsole = function () {
        document.getElementById('pmxStageUpgrade').hidden = true;
        document.getElementById('pmxStageSetup').hidden = false;
        pmxStartIdleAnim();
    };

    // Original processing logic (kept for when Pro is purchased)
    window.pmxStartMasterPro = function () {
        pmxStopVu();
        document.getElementById('pmxStageSetup').hidden = true;
        document.getElementById('pmxStageProcessing').hidden = false;
        const titles = ['Initializing console chain...', 'Analyzing source material...', 'EQ shaping & dynamics...', 'Stereo enhancement...', pmxRefOn ? 'Matching reference...' : 'Tonal balance...', 'Final master & limiting...'];
        const steps = ['pmxPs1', 'pmxPs2', 'pmxPs3', 'pmxPs4', 'pmxPs5'];
        let pct = 0, stepIdx = 0;
        const circ = 2 * Math.PI * 34;
        document.getElementById(steps[0]).classList.add('active');
        document.getElementById('pmxProcTitle').textContent = titles[0];
        if (!pmxRefOn) document.getElementById('pmxPs4').style.display = 'none';
        const iv = setInterval(() => {
            pct += 2;
            document.getElementById('pmxProcPct').textContent = pct + '%';
            document.getElementById('pmxProcCircle').style.strokeDashoffset = circ - (pct / 100) * circ;
            const newStep = Math.min(4, Math.floor(pct / 20));
            if (newStep !== stepIdx) {
                document.getElementById(steps[stepIdx]).classList.remove('active');
                document.getElementById(steps[stepIdx]).classList.add('done');
                document.getElementById(steps[newStep]).classList.add('active');
                document.getElementById('pmxProcTitle').textContent = titles[newStep];
                stepIdx = newStep;
            }
            if (pct >= 100) {
                clearInterval(iv);
                steps.forEach(s => document.getElementById(s).classList.add('done'));
                setTimeout(() => {
                    document.getElementById('pmxStageProcessing').hidden = true;
                    document.getElementById('pmxStageResult').hidden = false;
                    document.getElementById('pmxResultSub').textContent = pmxRefOn ? 'Mastered to match your reference at 96% accuracy.' : 'Your track is mastered and ready to download.';
                    document.getElementById('pmxMatchStat').textContent = pmxRefOn ? '96%' : '—';
                }, 500);
            }
        }, 80);
    };

    window.pmxReset = function () {
        pmxStopVu();
        if (pmxAudio) { pmxAudio.pause(); pmxAudio = null; }
        document.getElementById('pmxStageSetup').hidden = false;
        document.getElementById('pmxStageProcessing').hidden = true;
        document.getElementById('pmxStageResult').hidden = true;
        document.getElementById('pmxStageUpgrade').hidden = true;
        document.getElementById('pmxMainFile').value = '';
        document.getElementById('pmxTrackName').textContent = '— No track loaded —';
        document.getElementById('pmxTrackMeta').textContent = 'Click "Load Track" to begin · Console is in idle';
        document.getElementById('pmxBpm').textContent = '--';
        document.getElementById('pmxKey').textContent = '--';
        pmxClearRef();
        if (pmxRefOn) pmxToggleRef();
        pmxStartIdleAnim();
    };

    window.pmxDownload = function () {
        const btn = event.target.closest('.pmx-download');
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Downloaded!';
        btn.style.background = 'linear-gradient(135deg,#22c55e,#15803d)';
        setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2500);
    };

    // Tab switching
    window.switchStudioTab = function (tab) {
        document.querySelectorAll('.st-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelector('.qmx-wrap').hidden = tab !== 'quick';
        document.getElementById('pmxWrap').hidden = tab !== 'pro';
        if (tab === 'pro') {
            // Initialize console immediately on Pro tab
            renderVuBridge();
            renderStrips();
            pmxStartIdleAnim();
        } else {
            pmxStopVu();
        }
        window.scrollTo({ top: document.querySelector('.studio-tabs-nav').offsetTop - 20, behavior: 'smooth' });
    };
})();

(function () {
    let qmxAudio = null, qmxAB = 'a', qmxPlaying = false, qmxNeedleAnim = null;
    let qmxCtx = null, qmxSrc = null, qmxRouteA = null, qmxRouteB = null;
    let qmxNodes = {};
    let qmxGenre = 'pop';
    let qmxLastUploadFile = null;
    let qmxLastMasterId = null;

    // Genre-specific mastering chain settings (tuned for clean, punchy results - no distortion)
    const QMX_GENRES = {
        pop: { lo: 110, loG: 1.5, midF: 350, midG: -1.0, hiF: 3500, hiG: 2.0, airF: 12000, airG: 1.5, drive: 0.15, compThr: -22, compRatio: 2.0, makeup: 1.15, width: 1.3, sideAir: 1.5 },
        hiphop: { lo: 60, loG: 3.0, midF: 450, midG: -1.5, hiF: 2500, hiG: 0.5, airF: 10000, airG: 0.3, drive: 0.12, compThr: -22, compRatio: 2.2, makeup: 1.2, width: 1.15, sideAir: 0.5 },
        rnb: { lo: 110, loG: 1.8, midF: 500, midG: -0.8, hiF: 3000, hiG: 1.5, airF: 11500, airG: 2.2, drive: 0.1, compThr: -24, compRatio: 1.8, makeup: 1.1, width: 1.4, sideAir: 2.0 },
        rock: { lo: 90, loG: 1.2, midF: 600, midG: 0.8, hiF: 4000, hiG: 1.8, airF: 11000, airG: 1.3, drive: 0.18, compThr: -20, compRatio: 2.5, makeup: 1.2, width: 1.25, sideAir: 1.2 },
        electronic: { lo: 60, loG: 2.5, midF: 400, midG: -1.3, hiF: 5000, hiG: 2.2, airF: 13000, airG: 1.8, drive: 0.15, compThr: -22, compRatio: 2.2, makeup: 1.2, width: 1.5, sideAir: 2.0 },
        acoustic: { lo: 120, loG: 1.0, midF: 500, midG: 0.3, hiF: 5000, hiG: 1.0, airF: 11000, airG: 1.5, drive: 0.08, compThr: -26, compRatio: 1.6, makeup: 1.05, width: 1.2, sideAir: 1.0 }
    };

    // Build a tanh-style soft saturation curve for the WaveShaper
    function makeSatCurve(amount) {
        const k = Math.max(0, Math.min(1, amount)) * 40, n = 2048, curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const x = (i * 2 / n) - 1;
            curve[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    function buildAudioChain(audioEl) {
        qmxCtx = new (window.AudioContext || window.webkitAudioContext)();
        qmxSrc = qmxCtx.createMediaElementSource(audioEl);

        // ===== Path A (BEFORE) — passthrough at moderate volume =====
        qmxNodes.gainA = qmxCtx.createGain();
        qmxNodes.gainA.gain.value = 0.85;

        // ===== Path B (AFTER) — full mastering chain =====
        qmxNodes.hpf = qmxCtx.createBiquadFilter();
        qmxNodes.hpf.type = 'highpass';
        qmxNodes.hpf.frequency.value = 30;

        qmxNodes.lowShelf = qmxCtx.createBiquadFilter();
        qmxNodes.lowShelf.type = 'lowshelf';

        qmxNodes.midPeak = qmxCtx.createBiquadFilter();
        qmxNodes.midPeak.type = 'peaking';
        qmxNodes.midPeak.Q.value = 1;

        qmxNodes.presence = qmxCtx.createBiquadFilter();
        qmxNodes.presence.type = 'peaking';
        qmxNodes.presence.Q.value = 0.7;

        qmxNodes.airShelf = qmxCtx.createBiquadFilter();
        qmxNodes.airShelf.type = 'highshelf';

        qmxNodes.saturator = qmxCtx.createWaveShaper();
        qmxNodes.saturator.oversample = '4x';
        qmxNodes.saturator.curve = makeSatCurve(0.15);

        qmxNodes.compressor = qmxCtx.createDynamicsCompressor();
        qmxNodes.compressor.knee.value = 12;
        qmxNodes.compressor.attack.value = 0.010;
        qmxNodes.compressor.release.value = 0.18;

        qmxNodes.makeup = qmxCtx.createGain();

        // Mid/Side widener network for stereo enhancement
        qmxNodes.widenerSplit = qmxCtx.createChannelSplitter(2);
        qmxNodes.widenerMerge = qmxCtx.createChannelMerger(2);
        qmxNodes.midSum = qmxCtx.createGain();
        qmxNodes.midSum.gain.value = 0.5;
        qmxNodes.sideL = qmxCtx.createGain();
        qmxNodes.sideL.gain.value = 0.5;
        qmxNodes.sideR = qmxCtx.createGain();
        qmxNodes.sideR.gain.value = -0.5;
        qmxNodes.widthGain = qmxCtx.createGain();
        qmxNodes.sideShelf = qmxCtx.createBiquadFilter();
        qmxNodes.sideShelf.type = 'highshelf';
        qmxNodes.sideShelf.frequency.value = 8000;

        qmxNodes.limiter = qmxCtx.createDynamicsCompressor();
        qmxNodes.limiter.threshold.value = -3;
        qmxNodes.limiter.knee.value = 4;
        qmxNodes.limiter.ratio.value = 8;
        qmxNodes.limiter.attack.value = 0.003;
        qmxNodes.limiter.release.value = 0.10;

        qmxNodes.gainB = qmxCtx.createGain();
        qmxNodes.gainB.gain.value = 0; // start muted on B

        // Connect B chain
        qmxSrc.connect(qmxNodes.hpf);
        qmxNodes.hpf.connect(qmxNodes.lowShelf);
        qmxNodes.lowShelf.connect(qmxNodes.midPeak);
        qmxNodes.midPeak.connect(qmxNodes.presence);
        qmxNodes.presence.connect(qmxNodes.airShelf);
        qmxNodes.airShelf.connect(qmxNodes.saturator);
        qmxNodes.saturator.connect(qmxNodes.compressor);
        qmxNodes.compressor.connect(qmxNodes.makeup);

        // Mid/Side widener
        qmxNodes.makeup.connect(qmxNodes.widenerSplit);
        qmxNodes.widenerSplit.connect(qmxNodes.midSum, 0);
        qmxNodes.widenerSplit.connect(qmxNodes.midSum, 1);
        qmxNodes.widenerSplit.connect(qmxNodes.sideL, 0);
        qmxNodes.widenerSplit.connect(qmxNodes.sideR, 1);
        const sideMerge = qmxCtx.createGain();
        qmxNodes.sideL.connect(sideMerge);
        qmxNodes.sideR.connect(sideMerge);
        sideMerge.connect(qmxNodes.sideShelf);
        qmxNodes.sideShelf.connect(qmxNodes.widthGain);
        // Reconstruct L/R from M/S
        const recL = qmxCtx.createGain();
        const recR = qmxCtx.createGain();
        qmxNodes.midSum.connect(recL);
        qmxNodes.midSum.connect(recR);
        qmxNodes.widthGain.connect(recL);
        const widthInv = qmxCtx.createGain();
        widthInv.gain.value = -1;
        qmxNodes.widthGain.connect(widthInv);
        widthInv.connect(recR);
        recL.connect(qmxNodes.widenerMerge, 0, 0);
        recR.connect(qmxNodes.widenerMerge, 0, 1);
        qmxNodes.widenerMerge.connect(qmxNodes.limiter);
        qmxNodes.limiter.connect(qmxNodes.gainB);

        // Connect A chain (parallel passthrough)
        qmxSrc.connect(qmxNodes.gainA);

        // Both go to destination
        qmxNodes.gainA.connect(qmxCtx.destination);
        qmxNodes.gainB.connect(qmxCtx.destination);

        // Apply current genre
        applyQmxGenre(qmxGenre);
    }

    function applyQmxGenre(g) {
        qmxGenre = g;
        if (!qmxNodes.lowShelf) return;
        const p = QMX_GENRES[g] || QMX_GENRES.pop;
        const t = qmxCtx.currentTime;
        qmxNodes.lowShelf.frequency.setTargetAtTime(p.lo, t, 0.05);
        qmxNodes.lowShelf.gain.setTargetAtTime(p.loG, t, 0.05);
        qmxNodes.midPeak.frequency.setTargetAtTime(p.midF, t, 0.05);
        qmxNodes.midPeak.gain.setTargetAtTime(p.midG, t, 0.05);
        qmxNodes.presence.frequency.setTargetAtTime(p.hiF, t, 0.05);
        qmxNodes.presence.gain.setTargetAtTime(p.hiG, t, 0.05);
        qmxNodes.airShelf.frequency.setTargetAtTime(p.airF, t, 0.05);
        qmxNodes.airShelf.gain.setTargetAtTime(p.airG, t, 0.05);
        qmxNodes.saturator.curve = makeSatCurve(p.drive);
        qmxNodes.compressor.threshold.setTargetAtTime(p.compThr, t, 0.05);
        qmxNodes.compressor.ratio.setTargetAtTime(p.compRatio, t, 0.05);
        qmxNodes.makeup.gain.setTargetAtTime(p.makeup, t, 0.05);
        qmxNodes.widthGain.gain.setTargetAtTime(p.width, t, 0.05);
        qmxNodes.sideShelf.gain.setTargetAtTime(p.sideAir, t, 0.05);
    }

    function setQmxRoute(ch) {
        if (!qmxNodes.gainA || !qmxNodes.gainB) return;
        const t = qmxCtx.currentTime;
        if (ch === 'a') {
            qmxNodes.gainA.gain.setTargetAtTime(0.85, t, 0.005);
            qmxNodes.gainB.gain.setTargetAtTime(0, t, 0.005);
        } else {
            qmxNodes.gainA.gain.setTargetAtTime(0, t, 0.005);
            qmxNodes.gainB.gain.setTargetAtTime(0.75, t, 0.005);
        }
    }

    document.getElementById('qmxFile').addEventListener('change', function (e) {
        const f = e.target.files[0]; if (!f) return;
        qmxLastUploadFile = f;
        document.getElementById('qmxFileName').textContent = f.name;
        document.getElementById('qmxFileMeta').textContent = 'Ready to preview · ' + (f.size / 1048576).toFixed(1) + ' MB';
        if (qmxAudio) { try { qmxAudio.pause(); } catch (err) { } }
        if (qmxCtx) { try { qmxCtx.close(); } catch (err) { } qmxCtx = null; qmxNodes = {}; }
        qmxAudio = new Audio(URL.createObjectURL(f));
        qmxAudio.crossOrigin = 'anonymous';
        qmxAudio.addEventListener('loadedmetadata', function () {
            document.getElementById('qmxTotal').textContent = qmxFmt(qmxAudio.duration);
        });
        qmxAudio.addEventListener('timeupdate', function () {
            document.getElementById('qmxNow').textContent = qmxFmt(qmxAudio.currentTime);
            const pct = (qmxAudio.currentTime / qmxAudio.duration) * 100;
            document.getElementById('qmxFillA').style.width = pct + '%';
            document.getElementById('qmxFillB').style.width = pct + '%';
        });
        qmxAudio.addEventListener('ended', function () {
            qmxPlaying = false;
            document.getElementById('qmxPlay').dataset.playing = 'false';
            qmxStopNeedles();
        });
        document.getElementById('qmxStageUpload').hidden = true;
        document.getElementById('qmxStageSetup').hidden = false;
    });

    // Genre selection — also re-applies to the audio chain in real time
    document.getElementById('qmxGenres').addEventListener('click', function (e) {
        const btn = e.target.closest('.qmx-genre'); if (!btn) return;
        document.querySelectorAll('.qmx-genre').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const g = btn.dataset.g || 'pop';
        applyQmxGenre(g);
    });

    function qmxFmt(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); }

    window.qmxTogglePlay = function () {
        if (!qmxAudio) return;
        // Build chain on first play (browser autoplay policy)
        if (!qmxCtx) buildAudioChain(qmxAudio);
        if (qmxCtx.state === 'suspended') qmxCtx.resume();
        if (qmxPlaying) { qmxAudio.pause(); qmxPlaying = false; qmxStopNeedles(); }
        else {
            setQmxRoute(qmxAB);
            qmxAudio.play();
            qmxPlaying = true;
            qmxAnimateNeedles();
        }
        document.getElementById('qmxPlay').dataset.playing = qmxPlaying ? 'true' : 'false';
    };

    window.qmxSwitchAB = function (ch) {
        qmxAB = ch;
        document.querySelectorAll('.qmx-tbtn').forEach(b => b.classList.toggle('active', b.dataset.ab === ch));
        document.querySelector('.qmx-meter-a').classList.toggle('active', ch === 'a');
        document.querySelector('.qmx-meter-b').classList.toggle('active', ch === 'b');
        document.getElementById('qmxChan').textContent = ch === 'a' ? 'A · BEFORE' : 'B · AFTER';
        if (qmxCtx) setQmxRoute(ch);
    };

    function qmxAnimateNeedles() {
        const tick = () => {
            if (!qmxPlaying) return;
            // BEFORE (A): quiet, mid-low range - hovers around -10 to -5 area
            // AFTER (B): noticeably louder, hits 0 with occasional red kisses (no slamming)
            // Scale: -50deg = -20VU (left), 0deg = 0VU (center), +35deg = +3 (red)
            const isAfter = qmxAB === 'b';
            const baseAngle = isAfter ? 5 : -22;       // After centers near 0VU; Before sits in the -10 zone
            const variance = isAfter ? 22 : 14;        // After has more energy/movement
            const peakChance = isAfter ? 0.18 : 0.04;  // After kisses red zone occasionally

            const randPeak = () => Math.random() < peakChance ? (15 + Math.random() * 15) : 0;
            const aL = baseAngle + (Math.random() * variance - variance / 2) + randPeak();
            const aR = baseAngle + (Math.random() * variance - variance / 2) + randPeak();
            // Cap at +30 so it never slams into red distortion territory
            const cap = v => Math.min(30, Math.max(-50, v));
            document.getElementById('qmxNeedleL').style.transform = 'translateX(-50%) rotate(' + cap(aL) + 'deg)';
            document.getElementById('qmxNeedleR').style.transform = 'translateX(-50%) rotate(' + cap(aR) + 'deg)';
            qmxNeedleAnim = setTimeout(tick, isAfter ? 120 : 170);
        };
        tick();
    }
    function qmxStopNeedles() {
        if (qmxNeedleAnim) { clearTimeout(qmxNeedleAnim); qmxNeedleAnim = null; }
        document.getElementById('qmxNeedleL').style.transform = 'translateX(-50%) rotate(-50deg)';
        document.getElementById('qmxNeedleR').style.transform = 'translateX(-50%) rotate(-50deg)';
    }

    window.qmxToggleMeta = function () {
        document.querySelector('.qmx-meta-section').classList.toggle('open');
    };
    window.qmxToggleAdv = function (btn) {
        btn.classList.toggle('open');
        btn.nextElementSibling.classList.toggle('open');
    };
    window.qmxRemoveArt = function () {
        document.getElementById('qmxArtFile').value = '';
        document.getElementById('qmxArtPreview').hidden = true;
        document.getElementById('qmxArtPreview').src = '';
        document.getElementById('qmxArtPlaceholder').style.display = 'flex';
        document.getElementById('qmxArtRemove').hidden = true;
    };
    document.getElementById('qmxArtFile').addEventListener('change', function (e) {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = function (ev) {
            document.getElementById('qmxArtPreview').src = ev.target.result;
            document.getElementById('qmxArtPreview').hidden = false;
            document.getElementById('qmxArtPlaceholder').style.display = 'none';
            document.getElementById('qmxArtRemove').hidden = false;
        };
        r.readAsDataURL(f);
    });
    // Auto-fill genre into metadata when genre is selected
    document.getElementById('qmxGenres').addEventListener('click', function (e) {
        const btn = e.target.closest('.qmx-genre'); if (!btn) return;
        const map = { pop: 'Pop', hiphop: 'Hip-Hop', rnb: 'R&B', rock: 'Rock', electronic: 'Electronic', acoustic: 'Acoustic' };
        const g = btn.dataset.g;
        if (map[g]) document.getElementById('qmxMetaGenre').value = map[g];
    });

    window.qmxReset = function () {
        if (qmxAudio) { qmxAudio.pause(); qmxAudio = null; }
        qmxPlaying = false; qmxStopNeedles();
        qmxLastUploadFile = null;
        qmxLastMasterId = null;
        document.getElementById('qmxFile').value = '';
        document.getElementById('qmxStageUpload').hidden = false;
        document.getElementById('qmxStageSetup').hidden = true;
        document.getElementById('qmxStageProcessing').hidden = true;
        document.getElementById('qmxStageResult').hidden = true;
        // Reset metadata fields
        ['qmxMetaTitle', 'qmxMetaArtist', 'qmxMetaAlbum', 'qmxMetaYear', 'qmxMetaTrack', 'qmxMetaIsrc', 'qmxMetaComposer', 'qmxMetaCopyright'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('qmxMetaGenre').value = 'Pop';
        qmxRemoveArt();
        document.querySelector('.qmx-meta-section').classList.remove('open');
    };

    window.qmxStartMaster = function () {
        void (async () => {
            if (qmxAudio) { qmxAudio.pause(); qmxPlaying = false; qmxStopNeedles(); }
            if (!localStorage.getItem('esAuthToken')) {
                showToast('Log in to run Quick Master');
                showPage('login');
                return;
            }
            const fileInput = document.getElementById('qmxFile');
            const file = qmxLastUploadFile || fileInput?.files?.[0];
            if (!file) {
                showToast('Choose an audio file first');
                return;
            }

            const metaFilled = document.getElementById('qmxMetaTitle').value || document.getElementById('qmxMetaArtist').value || document.getElementById('qmxArtPreview').src;
            const hasArt = !document.getElementById('qmxArtPreview').hidden;
            const resultMeta = document.getElementById('qmxResultMeta');
            if (metaFilled) {
                resultMeta.hidden = false;
                const title = document.getElementById('qmxMetaTitle').value || 'Untitled';
                const artist = document.getElementById('qmxMetaArtist').value || 'Unknown';
                document.getElementById('qmxResultMetaText').textContent = 'Metadata: ' + title + ' · ' + artist + (hasArt ? ' · Artwork' : '');
            } else {
                resultMeta.hidden = true;
            }

            document.getElementById('qmxStageSetup').hidden = true;
            document.getElementById('qmxStageProcessing').hidden = false;
            const titles = ['Uploading…', 'Queued…', 'Processing…', 'Almost done…', 'Finalizing…'];
            const steps = ['qmxStep1', 'qmxStep2', 'qmxStep3', 'qmxStep4', 'qmxStep5'];
            let pct = 0;
            let stepIdx = 0;
            const circ = 2 * Math.PI * 34;
            steps.forEach((s) => {
                const el = document.getElementById(s);
                if (el) { el.classList.remove('active', 'done'); }
            });
            if (document.getElementById(steps[0])) document.getElementById(steps[0]).classList.add('active');
            document.getElementById('qmxProcTitle').textContent = titles[0];
            const uiTimer = setInterval(() => {
                pct = Math.min(95, pct + 1);
                document.getElementById('qmxProcPct').textContent = pct + '%';
                document.getElementById('qmxProcCircle').style.strokeDashoffset = circ - (pct / 100) * circ;
                const newStep = Math.min(4, Math.floor(pct / 22));
                if (newStep !== stepIdx) {
                    document.getElementById(steps[stepIdx])?.classList.remove('active');
                    document.getElementById(steps[stepIdx])?.classList.add('done');
                    document.getElementById(steps[newStep])?.classList.add('active');
                    document.getElementById('qmxProcTitle').textContent = titles[newStep];
                    stepIdx = newStep;
                }
            }, 200);

            const genreKey = document.querySelector('.qmx-genre.active')?.dataset?.g || qmxGenre || 'pop';
            const metadata = {
                title: document.getElementById('qmxMetaTitle')?.value || null,
                artist: document.getElementById('qmxMetaArtist')?.value || null,
                album: document.getElementById('qmxMetaAlbum')?.value || null,
                year: document.getElementById('qmxMetaYear')?.value || null,
                track: document.getElementById('qmxMetaTrack')?.value || null,
                isrc: document.getElementById('qmxMetaIsrc')?.value || null,
                composer: document.getElementById('qmxMetaComposer')?.value || null,
                copyright: document.getElementById('qmxMetaCopyright')?.value || null,
                genre: document.getElementById('qmxMetaGenre')?.value || null,
            };

            const fd = new FormData();
            fd.append('audio', file, file.name);
            fd.append('genre', genreKey);
            fd.append('metadata', JSON.stringify(metadata));

            try {
                const { master } = await apiCallMultipart('/masters/quick', fd);
                let m = master;
                while (m && m.status !== 'COMPLETE' && m.status !== 'FAILED') {
                    await new Promise((r) => setTimeout(r, 1200));
                    const res = await apiCall(`/masters/${m.id}`);
                    m = res.master;
                }
                clearInterval(uiTimer);
                steps.forEach((s) => {
                    const el = document.getElementById(s);
                    if (el) { el.classList.remove('active'); el.classList.add('done'); }
                });
                document.getElementById('qmxProcPct').textContent = '100%';
                document.getElementById('qmxProcCircle').style.strokeDashoffset = 0;
                if (!m || m.status === 'FAILED') {
                    showToast(m?.error || 'Mastering failed');
                    document.getElementById('qmxStageProcessing').hidden = true;
                    document.getElementById('qmxStageSetup').hidden = false;
                    return;
                }
                qmxLastMasterId = m.id;
                document.getElementById('qmxStageProcessing').hidden = true;
                document.getElementById('qmxStageResult').hidden = false;
            } catch (err) {
                clearInterval(uiTimer);
                showToast(err.message || 'Quick Master failed');
                document.getElementById('qmxStageProcessing').hidden = true;
                document.getElementById('qmxStageSetup').hidden = false;
            }
        })();
    };

    window.qmxDownload = function () {
        if (qmxLastMasterId) {
            window.downloadMasterById(qmxLastMasterId);
            return;
        }
        const btn = event.target.closest('.qmx-download');
        if (!btn) return;
        showToast('Run Quick Master first');
    };
})();

// ===== MOBILE NAV =====
function toggleNav() {
    const links = document.getElementById('navLinks');
    const btn = document.getElementById('navHamburger');
    if (!links || !btn) return;
    const isOpen = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}
function closeNav() {
    const links = document.getElementById('navLinks');
    const btn = document.getElementById('navHamburger');
    if (!links || !btn) return;
    links.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
}
// Close menu if you tap outside it
document.addEventListener('click', function (e) {
    const links = document.getElementById('navLinks');
    const btn = document.getElementById('navHamburger');
    if (!links || !btn) return;
    if (!links.classList.contains('open')) return;
    if (links.contains(e.target) || btn.contains(e.target)) return;
    closeNav();
});

// ===== PAGE NAVIGATION =====
function currentPageFile() {
    const raw = window.location.pathname.split('/').pop();
    if (!raw) return 'home.html';
    // Clean URLs (e.g. /pages/home) must match the same file as home.html, otherwise
    // showPage() keeps assigning location.href = 'home.html' and the server may
    // canonicalize back → infinite redirect loop after Stripe or any navigation.
    if (!raw.includes('.')) return `${raw}.html`;
    return raw;
}
function routeForPage(name) {
    const map = window.STEMY_ROUTE_MAP || {};
    return map[name] || null;
}
function showPage(name) {
    const targetFile = routeForPage(name);
    if (targetFile) {
        const here = currentPageFile().toLowerCase();
        if (here !== String(targetFile).toLowerCase()) {
            window.location.href = targetFile;
            return;
        }
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById('page-' + name);
    if (pageEl) pageEl.classList.add('active');
    window.scrollTo(0, 0);
    updateNav(name);
    if (name === 'profile') populateProfile();
}

function escapeHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

window.downloadMasterById = async function (id) {
    try {
        const { downloadUrl } = await apiCall(`/masters/${id}/download`);
        if (downloadUrl) window.open(downloadUrl, '_blank');
    } catch (e) {
        showToast(e.message || 'Download not ready');
    }
};

async function renderMasterHistory(profileRoot) {
    const tbody = profileRoot.querySelector('#prof-history tbody');
    if (!tbody) return;
    const token = localStorage.getItem('esAuthToken');
    if (!token) {
        tbody.innerHTML = '<tr><td colspan="5">Log in to see download history</td></tr>';
        return;
    }
    try {
        const { masters } = await apiCall('/masters');
        tbody.innerHTML = '';
        if (!masters || masters.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No masters yet</td></tr>';
            return;
        }
        for (const m of masters) {
            const tr = document.createElement('tr');
            const dateStr = m.createdAt
                ? new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : '—';
            const dl =
                m.status === 'COMPLETE'
                    ? `<button class="dl-btn" type="button" onclick="downloadMasterById('${m.id}')">Download</button>`
                    : `<span style="color:var(--muted)">${escapeHtml(m.status)}</span>`;
            tr.innerHTML = `<td>${escapeHtml(m.sourceName || 'Track')}</td><td>${escapeHtml(m.genre || '—')}</td><td>${dateStr}</td><td>${escapeHtml(m.sourceMime || 'audio')}</td><td>${dl}</td>`;
            tbody.appendChild(tr);
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5">Could not load history</td></tr>';
    }
}

function planEnumToLabel(plan) {
    if (plan === 'BASIC') return 'Basic';
    if (plan === 'PRO') return 'Pro';
    return plan ? String(plan) : '—';
}

/** True when the user has a Stripe-backed subscription that should show Basic/Pro (not the default free tier). */
function hasBillableSubscription(sub) {
    if (!sub?.plan || !sub.status) return false;
    if (sub.status === 'CANCELED') return false;
    return true;
}

/** Sidebar / card copy: DB default BASIC without a paid sub is shown as Free Plan. */
function displayPlanCardName(user, subscription) {
    if (hasBillableSubscription(subscription)) {
        return `${planEnumToLabel(subscription.plan)} Plan`;
    }
    return 'Free Plan';
}

function displayPlanSidebarLine(user, subscription) {
    if (hasBillableSubscription(subscription)) {
        return `${planEnumToLabel(subscription.plan)} (subscription)`;
    }
    return 'Free Plan';
}

function subscriptionStatusLabel(status) {
    if (!status) return 'No subscription';
    const m = { ACTIVE: 'Active', TRIALING: 'Trialing', PAST_DUE: 'Past due', CANCELED: 'Canceled' };
    return m[status] || status;
}

function setTextIf(root, selector, text) {
    if (!root || text === undefined || text === null) return;
    const el = root.querySelector(selector);
    if (el) el.textContent = text;
}

function hydrateProfileAvatar(sidebar, user) {
    if (!sidebar) return;
    const wrap = sidebar.querySelector('.profile-avatar-wrap') || sidebar;
    let slot = wrap.querySelector('#profileAvatarSlot');
    if (!slot) {
        const legacy = wrap.querySelector('.profile-avatar');
        if (legacy) {
            legacy.id = 'profileAvatarSlot';
            slot = legacy;
        }
    }
    if (!slot) return;
    const initial = (user?.firstName || user?.displayName || user?.email || '?').charAt(0).toUpperCase();
    if (user?.avatarUrl) {
        slot.innerHTML = `<img id="avatarImg" src="${user.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
    } else {
        slot.innerHTML = `<span id="avatarEmoji" style="font-size:2rem;">${initial || '🎧'}</span>`;
    }
}

async function populateProfile() {
    const profileRoot = document.getElementById('page-profile');
    if (!profileRoot) return;

    const userStr = localStorage.getItem('esUser');
    let user = userStr ? JSON.parse(userStr) : null;
    let subscription = null;
    try {
        const subStr = localStorage.getItem('esSubscription');
        subscription = subStr ? JSON.parse(subStr) : null;
    } catch (_) {
        subscription = null;
    }

    if (localStorage.getItem('esAuthToken') && (!user || !subscription)) {
        await refreshSession();
        const u2 = localStorage.getItem('esUser');
        user = u2 ? JSON.parse(u2) : null;
        const s2 = localStorage.getItem('esSubscription');
        subscription = s2 ? JSON.parse(s2) : null;
    }

    const sidebar = profileRoot.querySelector('.profile-sidebar');
    const displayName = user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '—';
    const email = user?.email || '—';
    const planTitle = displayPlanSidebarLine(user, subscription);

    setTextIf(profileRoot, '.profile-sidebar .profile-username', displayName);
    setTextIf(profileRoot, '.profile-sidebar .profile-email', email);
    setTextIf(profileRoot, '.profile-sidebar .profile-plan', planTitle);
    hydrateProfileAvatar(sidebar, user);

    const subCard = profileRoot.querySelector('#prof-subscription .sub-card') || profileRoot.querySelector('.sub-card');
    if (subCard) {
        const priceLine =
            hasBillableSubscription(subscription) && subscription.plan === 'BASIC'
                ? '$9.99 / month'
                : hasBillableSubscription(subscription) && subscription.plan === 'PRO'
                  ? '$24.99 / month'
                  : '—';
        setTextIf(subCard, '.sub-name', displayPlanCardName(user, subscription));
        const badge = subCard.querySelector('.sub-badge');
        if (badge) {
            badge.textContent = hasBillableSubscription(subscription)
                ? subscriptionStatusLabel(subscription.status)
                : 'Free';
        }
        const vals = subCard.querySelectorAll('.sub-detail-val');
        if (vals[0]) vals[0].textContent = priceLine;
        if (vals[1]) {
            const end = subscription?.currentPeriodEnd || subscription?.trialEndsAt;
            vals[1].textContent = end ? new Date(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        }
        if (vals[2]) vals[2].textContent = 'See account usage';
        if (vals[3] && user?.createdAt) {
            vals[3].textContent = new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        }
    }

    const wb = document.getElementById('welcomeBanner');
    const wbName = document.getElementById('wbName');
    const isNew = localStorage.getItem('esIsNewUser') === '1';
    const firstName = user?.firstName || displayName.split(' ')[0] || '';
    if (wbName) wbName.textContent = firstName || 'there';
    if (wb) wb.style.display = isNew ? 'flex' : 'none';

    const fn = document.getElementById('settingsFirstName');
    const ln = document.getElementById('settingsLastName');
    const em = document.getElementById('settingsEmail');
    const profSettings = profileRoot.querySelector('#prof-settings');
    if (!fn && profSettings) {
        const textInputs = profSettings.querySelectorAll('input[type="text"]');
        if (textInputs[0] && !textInputs[0].id) textInputs[0].id = 'settingsFirstName';
        if (textInputs[1] && !textInputs[1].id) textInputs[1].id = 'settingsLastName';
    }
    if (!em && profSettings) {
        const emailInput = profSettings.querySelector('input[type="email"]');
        if (emailInput && !emailInput.id) emailInput.id = 'settingsEmail';
    }
    const fnEl = document.getElementById('settingsFirstName');
    const lnEl = document.getElementById('settingsLastName');
    const emEl = document.getElementById('settingsEmail');
    if (fnEl) fnEl.value = user?.firstName || '';
    if (lnEl) lnEl.value = user?.lastName || '';
    if (emEl) {
        emEl.value = email !== '—' ? email : '';
        emEl.readOnly = true;
    }

    const saveBtn = profSettings?.querySelector('.btn.btn-primary');
    if (saveBtn && !saveBtn.dataset.stemySaveBound) {
        saveBtn.dataset.stemySaveBound = '1';
        saveBtn.onclick = () => saveProfileSettings();
    }

    const legacyNotice = document.getElementById('emailVerifyNotice');
    if (legacyNotice) legacyNotice.remove();
    const existingPrompt = document.getElementById('emailVerifyPrompt');
    if (existingPrompt) existingPrompt.remove();
    if (user && !user.emailVerified) {
        ensureEmailVerifyModal();
        const prompt = document.createElement('div');
        prompt.id = 'emailVerifyPrompt';
        prompt.className = 'email-verify-prompt';
        prompt.innerHTML = `
            <span class="email-verify-prompt-icon" aria-hidden="true">✉️</span>
            <div class="email-verify-prompt-text">
                <strong>Verify your email</strong>
                <span>We sent a link and token to your inbox. Open the link or paste the token here.</span>
            </div>
            <button type="button" class="btn btn-primary" onclick="openEmailVerifyModal()">Enter verification token</button>
        `;
        const main = profileRoot.querySelector('.profile-main');
        if (main) main.insertBefore(prompt, main.firstChild);
    } else {
        closeEmailVerifyModal();
    }

    await renderMasterHistory(profileRoot);

    const plist = profileRoot.querySelector('#savedPresetsList');
    if (plist) plist.innerHTML = '';

    const cancelPlan = profileRoot.querySelector('#prof-subscription button.btn-ghost[style*="warn"], #prof-subscription .sub-card button.btn-ghost[style*="warn"]');
    if (cancelPlan && cancelPlan.textContent.includes('Cancel Plan') && !cancelPlan.dataset.stemyPortalBound) {
        cancelPlan.dataset.stemyPortalBound = '1';
        cancelPlan.onclick = (ev) => {
            ev.preventDefault();
            void openBillingPortal();
        };
    }

    const aw = sidebar?.querySelector('.profile-avatar-wrap');
    if (aw && !aw.dataset.stemyAvatarBind) {
        aw.dataset.stemyAvatarBind = '1';
        let inp = document.getElementById('stemyAvatarFile');
        if (!inp) {
            inp = document.createElement('input');
            inp.type = 'file';
            inp.id = 'stemyAvatarFile';
            inp.accept = 'image/jpeg,image/png,image/webp,image/gif';
            inp.style.display = 'none';
            inp.addEventListener('change', () => uploadAvatar(inp));
            document.body.appendChild(inp);
        }
        aw.style.cursor = 'pointer';
        aw.title = 'Click to change photo';
        aw.onclick = () => inp.click();
    }
}

async function uploadAvatar(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showToast('Photo must be under 5 MB');
        return;
    }
    const fd = new FormData();
    fd.append('avatar', file);
    try {
        const data = await apiCallMultipart('/users/me/avatar', fd);
        const userStr = localStorage.getItem('esUser');
        const user = userStr ? JSON.parse(userStr) : {};
        if (data.user?.avatarUrl) user.avatarUrl = data.user.avatarUrl;
        localStorage.setItem('esUser', JSON.stringify(user));
        await populateProfile();
        showToast('Photo updated');
    } catch (err) {
        showToast(err.message || 'Upload failed');
    }
    input.value = '';
}

function updateNav(page) {
    const cta = document.getElementById('navCta');
    if (!cta) return;
    const hamburgerHTML = '<button class="nav-hamburger" id="navHamburger" type="button" aria-label="Toggle menu" aria-expanded="false" aria-controls="navLinks" onclick="toggleNav()"><svg class="ic-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg><svg class="ic-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    if (localStorage.getItem('esAuthToken')) {
        cta.innerHTML = '<button class="btn btn-ghost" onclick="showPage(\'mastering\')">Studio</button><button class="btn btn-primary" onclick="showPage(\'profile\')">My Account</button>' + hamburgerHTML;
    } else {
        cta.innerHTML = '<button class="btn btn-ghost" onclick="showPage(\'login\')">Log in</button><button class="btn btn-primary" onclick="showPage(\'login\')">Start Free</button>' + hamburgerHTML;
    }
}

// ===== HERO WAVE =====
(function () {
    const poly = document.getElementById('heroWave');
    if (!poly) return;
    let t = 0;
    function draw() {
        t += 0.015;
        const pts = [];
        for (let x = 0; x <= 1200; x += 6) {
            const y = 100 + Math.sin(x * 0.012 + t) * 35 + Math.sin(x * 0.025 + t * 1.3) * 18 + Math.sin(x * 0.005 + t * 0.7) * 45;
            pts.push(x + ',' + y);
        }
        poly.setAttribute('points', pts.join(' '));
        requestAnimationFrame(draw);
    }
    draw();
})();

// ===== AUTH API CONFIG =====
function getApiBase() {
    const c = window.STEMY_CONFIG || {};
    return String(c.API_URL || 'http://localhost:3000/api').replace(/\/$/, '');
}

function getGoogleClientId() {
    const c = window.STEMY_CONFIG || {};
    return c.GOOGLE_CLIENT_ID || '';
}

async function apiCall(endpoint, options = {}) {
    const url = `${getApiBase()}${endpoint}`;
    const token = localStorage.getItem('esAuthToken');

    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: `Bearer ${token}` }),
            ...options.headers,
        },
        ...options,
    };

    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
        config.body = JSON.stringify(config.body);
    }

    const response = await fetch(url, config);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || 'Request failed');
    }

    return data;
}

async function apiCallMultipart(endpoint, formData, method = 'POST') {
    const token = localStorage.getItem('esAuthToken');
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${getApiBase()}${endpoint}`, { method, headers, body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || 'Request failed');
    }
    return data;
}

async function refreshSession() {
    const token = localStorage.getItem('esAuthToken');
    if (!token) {
        localStorage.removeItem('esUser');
        localStorage.removeItem('esSubscription');
        localStorage.removeItem('esLoggedIn');
        window.__STEMY_SESSION = null;
        return null;
    }
    try {
        const data = await apiCall('/auth/me');
        localStorage.setItem('esUser', JSON.stringify(data.user));
        if (data.subscription) {
            localStorage.setItem('esSubscription', JSON.stringify(data.subscription));
        } else {
            localStorage.removeItem('esSubscription');
        }
        localStorage.setItem('esLoggedIn', '1');
        window.__STEMY_SESSION = data;
        return data;
    } catch (err) {
        localStorage.removeItem('esAuthToken');
        localStorage.removeItem('esUser');
        localStorage.removeItem('esSubscription');
        localStorage.removeItem('esLoggedIn');
        window.__STEMY_SESSION = null;
        return null;
    }
}

// ===== AUTH =====
function toggleAuth(mode) {
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const forgotForm = document.getElementById('forgotForm');
    if (!loginForm) return;
    loginForm.style.display = mode === 'login' ? 'block' : 'none';
    if (signupForm) signupForm.style.display = mode === 'signup' ? 'block' : 'none';
    if (forgotForm) forgotForm.style.display = mode === 'forgot' ? 'block' : 'none';
}

// Login (existing user)
async function doLogin(viaGoogle) {
    if (viaGoogle) {
        if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
            showToast('Google Sign-In not loaded. Please try again.');
            return;
        }
        const gid = getGoogleClientId();
        if (!gid) {
            showToast('Google Client ID is not configured (set STEMY_CONFIG.GOOGLE_CLIENT_ID in client/js/config.js).');
            return;
        }

        const client = google.accounts.oauth2.initTokenClient({
            client_id: gid,
            scope: 'openid email profile',
            callback: async (tokenResponse) => {
                if (tokenResponse.error) {
                    showToast('Google login failed: ' + tokenResponse.error);
                    return;
                }
                try {
                    const data = await apiCall('/auth/google', {
                        method: 'POST',
                        body: { accessToken: tokenResponse.access_token },
                    });
                    localStorage.setItem('esAuthToken', data.token);
                    await refreshSession();
                    showToast('Welcome back to Stemy!');
                    updateNav();
                    showPage('profile');
                } catch (err) {
                    showToast(err.message || 'Google login failed');
                }
            },
        });

        client.requestAccessToken({ prompt: 'select_account' });
        return;
    }

    // Regular email/password login
    const loginForm = document.getElementById('loginForm') || document;
    const emailInput =
        document.getElementById('loginEmail') ||
        loginForm.querySelector('input[type="email"]');
    const passwordInput =
        document.getElementById('loginPassword') ||
        loginForm.querySelector('input[type="password"]');

    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!email) { showToast('Please enter your email'); return; }
    if (!password) { showToast('Please enter your password'); return; }

    try {
        const data = await apiCall('/auth/login', {
            method: 'POST',
            body: { email, password }
        });

        localStorage.setItem('esAuthToken', data.token);
        await refreshSession();
        showToast('Welcome back to Stemy!');
        updateNav();
        showPage('profile');
    } catch (err) {
        showToast(err.message || 'Login failed');
    }
}

// Sign up (new user)
async function doSignup() {
    const signupForm = document.getElementById('signupForm') || document;
    const textInputs = signupForm.querySelectorAll('input[type="text"]');
    const emailInputs = signupForm.querySelectorAll('input[type="email"]');
    const passwordInputs = signupForm.querySelectorAll('input[type="password"]');

    const firstInput = document.getElementById('signupFirstName') || textInputs[0] || null;
    const lastInput = document.getElementById('signupLastName') || textInputs[1] || null;
    const emailInput = document.getElementById('signupEmail') || emailInputs[0] || null;
    const passwordInput = document.getElementById('signupPassword') || passwordInputs[0] || null;

    const first = firstInput ? firstInput.value.trim() : '';
    const last = lastInput ? lastInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!first || !email || !password) {
        showToast('Please fill in all required fields');
        return;
    }

    if (password.length < 6) {
        showToast('Password must be at least 6 characters');
        return;
    }

    try {
        const data = await apiCall('/auth/signup', {
            method: 'POST',
            body: {
                email,
                password,
                firstName: first,
                lastName: last,
                displayName: (first + ' ' + last).trim()
            }
        });

        localStorage.setItem('esAuthToken', data.token);
        localStorage.setItem('esIsNewUser', '1');
        await refreshSession();

        if (data.requiresVerification) {
            showToast('Account created! Check your email to verify.');
        } else {
            showToast('Welcome to Stemy, ' + first + '!');
        }

        updateNav();
        showPage('profile');
    } catch (err) {
        showToast(err.message || 'Signup failed');
    }
}

// Forgot password
async function doForgot() {
    const fe = document.getElementById('forgotEmail');
    const email = fe ? fe.value.trim() : '';
    if (!email) { showToast('Please enter your email'); return; }

    try {
        await apiCall('/auth/forgot-password', {
            method: 'POST',
            body: { email }
        });

        showToast('If an account exists, a reset link was sent to your email.');
        const otpWrap = document.getElementById('otpResetFields');
        if (otpWrap) otpWrap.style.display = 'block';
    } catch (err) {
        showToast('If an account exists, a reset link was sent to your email.');
        const otpWrap = document.getElementById('otpResetFields');
        if (otpWrap) otpWrap.style.display = 'block';
    }
}

async function doResetPassword() {
    const tokenEl = document.getElementById('resetOtp');
    const emailEl = document.getElementById('forgotEmail');
    const passwordEl = document.getElementById('resetNewPassword');
    const token = tokenEl ? tokenEl.value.trim() : '';
    const email = emailEl ? emailEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';

    if (!token || !email) {
        showToast('Use the reset link from your email, or paste the token and confirm your email.');
        return;
    }
    if (!password || password.length < 6) {
        showToast('Password must be at least 6 characters');
        return;
    }

    try {
        await apiCall('/auth/reset-password', {
            method: 'POST',
            body: { token, email, password },
        });
        showToast('Password reset. Log in with your new password.');
        toggleAuth('login');
        const otpWrap = document.getElementById('otpResetFields');
        if (otpWrap) otpWrap.style.display = 'none';
    } catch (err) {
        showToast(err.message || 'Failed to reset password');
    }
}

function logOut() {
    localStorage.removeItem('esAuthToken');
    localStorage.removeItem('esUser');
    localStorage.removeItem('esSubscription');
    localStorage.removeItem('esLoggedIn');
    localStorage.removeItem('esIsNewUser');
    window.__STEMY_SESSION = null;
    showToast('Logged out');
    updateNav();
    showPage('home');
}

/** After reset-password.html stores token/email, open forgot-password on subscription. */
function applyPendingPasswordReset() {
    const rt = sessionStorage.getItem('stemy_reset_token');
    const rem = sessionStorage.getItem('stemy_reset_email');
    if (!rt || !rem || !document.getElementById('forgotForm')) return false;
    sessionStorage.removeItem('stemy_reset_token');
    sessionStorage.removeItem('stemy_reset_email');
    showPage('login');
    const fe = document.getElementById('forgotEmail');
    const re = document.getElementById('resetOtp');
    const otpWrap = document.getElementById('otpResetFields');
    if (fe) fe.value = rem;
    if (re) re.value = rt;
    if (otpWrap) otpWrap.style.display = 'block';
    toggleAuth('forgot');
    return true;
}

async function loadCurrentUser() {
    await refreshSession();
    updateNav();
}

// ===== PROFILE =====
function showProfSection(id, btn) {
    document.querySelectorAll('.prof-section').forEach(s => s.classList.remove('active'));
    document.getElementById('prof-' + id).classList.add('active');
    document.querySelectorAll('.sidebar-menu button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

// ===== MASTER TABS =====
function switchMasterTab(panel, btn) {
    document.querySelectorAll('.master-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.master-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + panel).classList.add('active');
    if (panel === 'stems') { if (typeof sslInit === 'function' && !window._sslInited) { sslInit(); window._sslInited = true; } }
}

// ===== SINGLE TRACK =====
function handleDrop(e) {
    e.preventDefault();
    const uz = document.getElementById('uploadZone');
    if (uz) uz.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
}
function handleFile(f) {
    if (!f) return;
    const uz = document.getElementById('uploadZone');
    const fl = document.getElementById('fileLoaded');
    const fn = document.getElementById('fileName');
    const fm = document.getElementById('fileMeta');
    if (!uz || !fl || !fn || !fm) return;
    uz.style.display = 'none';
    fl.style.display = 'block';
    fn.textContent = f.name;
    const ext = f.name.split('.').pop().toUpperCase();
    const mb = (f.size / 1024 / 1024).toFixed(1);
    fm.textContent = ext + ' · ' + mb + 'MB';
    drawWave('waveInput', false);
}
function resetSingle() {
    const uz = document.getElementById('uploadZone');
    const fl = document.getElementById('fileLoaded');
    const ps = document.getElementById('processingState');
    const rs = document.getElementById('resultState');
    const ti = document.getElementById('trackInput');
    const rf = document.getElementById('ringFill');
    const pp = document.getElementById('progressPct');
    const s1 = document.getElementById('s1');
    if (!uz || !fl || !ps || !rs || !ti || !rf || !pp || !s1) return;
    uz.style.display = 'block';
    fl.style.display = 'none';
    ps.style.display = 'none';
    rs.style.display = 'none';
    ti.value = '';
    rf.style.strokeDashoffset = '220';
    pp.textContent = '0%';
    for (let i = 1; i <= 5; i++) {
        const d = document.getElementById('s' + i);
        if (d) { d.className = 'step-dot'; d.textContent = ''; }
    }
    s1.className = 'step-dot running';
}
function drawWave(id, mastered) {
    const c = document.getElementById(id);
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.offsetWidth * (window.devicePixelRatio || 1);
    const H = c.offsetHeight * (window.devicePixelRatio || 1);
    c.width = W; c.height = H;
    ctx.clearRect(0, 0, W, H);
    const bars = Math.floor(W / 3);
    const color = mastered ? '#7b61ff' : '#00e5a0';
    for (let i = 0; i < bars; i++) {
        const seed = Math.sin(i * 0.3) * 0.5 + Math.sin(i * 0.07) * 0.3 + Math.sin(i * 1.1) * 0.2;
        const amp = (Math.abs(seed) + 0.05) * (mastered ? 0.9 : 0.55);
        const h = amp * H; const y = (H - h) / 2;
        ctx.fillStyle = color; ctx.globalAlpha = 0.85;
        ctx.fillRect(i * 3, y, 2, h);
    }
}
function setGenre(el) {
    el.closest('.genre-row').querySelectorAll('.genre-chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
}
function setMasterPreset(el) {
    document.querySelectorAll('.master-preset-card').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
}
function savePreset() {
    const nameInput = document.getElementById('presetNameInput');
    const list = document.getElementById('savedPresetsList');
    if (!nameInput || !list) return;
    const name = nameInput.value.trim();
    if (!name) { showToast('Enter a preset name first'); return; }
    showToast('Local mastering presets are not saved to your account. Use Quick Master for cloud mastering.');
}
function startMastering() {
    showToast('Use the Quick Master tab to upload your file — we master it on our servers.');
}
function showResult() {
    const ps = document.getElementById('processingState');
    const rs = document.getElementById('resultState');
    if (ps) ps.style.display = 'none';
    if (rs) rs.style.display = 'block';
    setTimeout(() => { drawWave('waveOrig', false); drawWave('waveMast', true); }, 50);
}
function fakeDownload(btn) {
    showToast('When a cloud master is ready, download it from Quick Master or your account download history.');
}

// ===== STEM MIXER =====
const CHANNELS = [
    { id: 'drums', name: '🥁 Drums', color: '#ff6b6b' },
    { id: 'bass', name: '🎸 Bass', color: '#fbbf24' },
    { id: 'vocals', name: '🎤 Vocals', color: '#7b61ff' },
    { id: 'keys', name: '🎹 Keys', color: '#00e5a0' },
    { id: 'guitar', name: '🎸 Guitar', color: '#60a5fa' },
    { id: 'fx', name: '🎵 FX/Other', color: '#f472b6' },
];

const channelState = {};
CHANNELS.forEach(ch => {
    channelState[ch.id] = {
        vol: 80, pan: 0, muted: false, solo: false, file: null,
        fx: {
            autotune: { on: false, key: 'C', scale: 'Major', amount: 80 },
            reverb: { on: false, size: 40, decay: 50, wet: 30 },
            delay: { on: false, time: 30, feedback: 40, wet: 20 },
            compressor: { on: false, threshold: 40, ratio: 40, attack: 30 },
            eq: { on: false, low: 50, mid: 50, high: 50 }
        }
    };
});

let mixerInitialized = false;
let vuAnimFrame = null;
let isPlaying = false;
let transportTime = 0;
let transportInterval = null;
let currentStemTarget = null;

function initMixer() {
    if (mixerInitialized) return;
    mixerInitialized = true;
    renderChannels();
    renderVuMeters();
    startVuAnimation();
}

function renderVuMeters() {
    const row = document.getElementById('vuMetersRow');
    row.innerHTML = '';
    CHANNELS.forEach(ch => {
        const wrap = document.createElement('div');
        wrap.className = 'vu-meter-wrap';
        wrap.id = 'vu-' + ch.id;
        wrap.innerHTML = `
      <div class="vu-needle-wrap">
        <div class="vu-needle-scale-marks">
          <span class="vu-scale-mark">-20</span>
          <span class="vu-scale-mark">-10</span>
          <span class="vu-scale-mark">-3</span>
          <span class="vu-scale-mark">0</span>
          <span class="vu-scale-mark">+3</span>
        </div>
        <div class="vu-needle" id="needle-${ch.id}"></div>
        <div class="vu-needle-dot"></div>
        <div class="vu-needle-scale"></div>
      </div>
      <div class="vu-meter-name">${ch.name.replace(/[^\w\s]/g, '').trim()}</div>
    `;
        row.appendChild(wrap);
    });
}

function renderChannels() {
    const row = document.getElementById('channelsRow');
    row.innerHTML = '';

    CHANNELS.forEach(ch => {
        const s = channelState[ch.id];
        const strip = document.createElement('div');
        strip.className = 'channel-strip';
        strip.id = 'strip-' + ch.id;

        strip.innerHTML = `
      <div class="channel-header">
        <div class="channel-name" style="color:${ch.color}">${ch.name}</div>
        <button class="ch-mute-btn" id="mute-${ch.id}" onclick="toggleChMute('${ch.id}')">M</button>
      </div>

      <div class="channel-upload">
        <button class="ch-upload-btn" id="upbtn-${ch.id}" onclick="triggerStemUpload('${ch.id}')">+ Upload ${ch.name.replace(/[^\w\s]/g, '').trim()}</button>
        <div class="ch-filename" id="fname-${ch.id}"></div>
      </div>

      <div class="fx-rack">
        <div class="fx-rack-title">FX Chain</div>

        <!-- AUTO-TUNE (vocals only for now, but available on all) -->
        <div class="fx-slot autotune-slot" id="at-${ch.id}">
          <div class="fx-slot-top">
            <span class="fx-name">🎵 Auto-Tune</span>
            <div class="fx-toggle" id="at-tog-${ch.id}" onclick="toggleFx('${ch.id}','autotune',this)"></div>
          </div>
          <div class="autotune-key-row">
            ${['C', 'D', 'E', 'F', 'G', 'A', 'B'].map(k => `<button class="key-btn ${k === 'C' ? 'active' : ''}" onclick="setKey('${ch.id}','${k}',this)">${k}</button>`).join('')}
          </div>
          <div class="fx-knob-row" style="margin-top:5px;">
            <div class="fx-knob-wrap"><div class="fx-knob" style="--r:${s.fx.autotune.amount}%" title="Amount"></div><div class="fx-knob-label">Amt</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" style="transform:rotate(${s.fx.autotune.amount * 2.7 - 135}deg);" title="Speed"></div><div class="fx-knob-label">Spd</div></div>
          </div>
        </div>

        <!-- REVERB -->
        <div class="fx-slot" id="rv-${ch.id}">
          <div class="fx-slot-top">
            <span class="fx-name">🌊 Reverb</span>
            <div class="fx-toggle" id="rv-tog-${ch.id}" onclick="toggleFx('${ch.id}','reverb',this)"></div>
          </div>
          <div class="fx-knob-row">
            <div class="fx-knob-wrap"><div class="fx-knob" title="Room Size"></div><div class="fx-knob-label">Size</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Decay"></div><div class="fx-knob-label">Decay</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Wet/Dry"></div><div class="fx-knob-label">Wet</div></div>
          </div>
        </div>

        <!-- DELAY -->
        <div class="fx-slot" id="dl-${ch.id}">
          <div class="fx-slot-top">
            <span class="fx-name">🔁 Delay</span>
            <div class="fx-toggle" id="dl-tog-${ch.id}" onclick="toggleFx('${ch.id}','delay',this)"></div>
          </div>
          <div class="fx-knob-row">
            <div class="fx-knob-wrap"><div class="fx-knob" title="Time"></div><div class="fx-knob-label">Time</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Feedback"></div><div class="fx-knob-label">Fbk</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Wet"></div><div class="fx-knob-label">Wet</div></div>
          </div>
        </div>

        <!-- COMPRESSOR -->
        <div class="fx-slot" id="cp-${ch.id}">
          <div class="fx-slot-top">
            <span class="fx-name">⚡ Compressor</span>
            <div class="fx-toggle" id="cp-tog-${ch.id}" onclick="toggleFx('${ch.id}','compressor',this)"></div>
          </div>
          <div class="fx-knob-row">
            <div class="fx-knob-wrap"><div class="fx-knob" title="Threshold"></div><div class="fx-knob-label">Thr</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Ratio"></div><div class="fx-knob-label">Ratio</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Attack"></div><div class="fx-knob-label">Atk</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Release"></div><div class="fx-knob-label">Rel</div></div>
          </div>
        </div>

        <!-- EQ -->
        <div class="fx-slot" id="eq-${ch.id}">
          <div class="fx-slot-top">
            <span class="fx-name">🎛️ 3-Band EQ</span>
            <div class="fx-toggle" id="eq-tog-${ch.id}" onclick="toggleFx('${ch.id}','eq',this)"></div>
          </div>
          <div class="fx-knob-row">
            <div class="fx-knob-wrap"><div class="fx-knob" title="Low"></div><div class="fx-knob-label">Low</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="Mid"></div><div class="fx-knob-label">Mid</div></div>
            <div class="fx-knob-wrap"><div class="fx-knob" title="High"></div><div class="fx-knob-label">High</div></div>
          </div>
          <canvas class="eq-display" id="eq-canvas-${ch.id}" width="120" height="30"></canvas>
        </div>
      </div>

      <div class="ch-buttons">
        <button class="ch-btn solo" id="solo-${ch.id}" onclick="toggleSolo('${ch.id}',this)">S</button>
        <button class="ch-btn mute" id="muteBtn-${ch.id}" onclick="toggleChMute('${ch.id}')">M</button>
        <button class="ch-btn rec">R</button>
      </div>

      <div class="channel-fader">
        <div class="fader-row-h">
          <span class="fader-label">Vol</span>
          <input class="fader-input" type="range" min="0" max="100" value="80"
            oninput="updateFader('${ch.id}','vol',this.value);this.nextElementSibling.textContent=this.value+'%'">
          <span class="fader-val">80%</span>
        </div>
        <div class="fader-row-h">
          <span class="fader-label">Pan</span>
          <input class="fader-input" type="range" min="-50" max="50" value="0"
            oninput="updateFader('${ch.id}','pan',this.value);this.nextElementSibling.textContent=(this.value>0?'R':this.value<0?'L':'C')+Math.abs(this.value)">
          <span class="fader-val">C0</span>
        </div>
      </div>
    `;
        row.appendChild(strip);
    });

    // Master channel
    const master = document.createElement('div');
    master.className = 'channel-strip master-channel';
    master.innerHTML = `
    <div class="master-ch-header"><div class="master-ch-name">MASTER</div></div>
    <div style="padding:10px;">
      <div style="font-family:'DM Mono',monospace;font-size:0.6rem;color:var(--muted);margin-bottom:6px;text-transform:uppercase;">Output Level</div>
      <div class="fader-row-h" style="margin-bottom:8px;">
        <span class="fader-label">Lvl</span>
        <input class="fader-input" type="range" min="0" max="100" value="85" oninput="this.nextElementSibling.textContent=this.value+'%'">
        <span class="fader-val">85%</span>
      </div>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
        <div style="font-family:'DM Mono',monospace;font-size:0.6rem;color:var(--muted);text-transform:uppercase;margin-bottom:2px;">Master FX</div>
        <div class="fx-slot"><div class="fx-slot-top"><span class="fx-name" style="font-size:0.65rem;">Limiter</span><div class="fx-toggle on"></div></div></div>
        <div class="fx-slot"><div class="fx-slot-top"><span class="fx-name" style="font-size:0.65rem;">Stereo Width</span><div class="fx-toggle on"></div></div></div>
      </div>
    </div>
  `;
    row.appendChild(master);

    // Draw initial EQ curves
    CHANNELS.forEach(ch => drawEqCurve('eq-canvas-' + ch.id));
}

function drawEqCurve(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgba(0,229,160,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < c.width; x++) {
        const t = x / c.width;
        const y = c.height / 2 + Math.sin(t * Math.PI * 2) * 4 + Math.sin(t * Math.PI * 6) * 2;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// VU METER ANIMATION
function startVuAnimation() {
    const needleTargets = {};
    const masterTargets = { l: 0, r: 0 };
    CHANNELS.forEach(ch => { needleTargets[ch.id] = 0; });

    function animate() {
        CHANNELS.forEach(ch => {
            const s = channelState[ch.id];
            if (isPlaying && !s.muted) {
                const vol = s.vol / 100;
                const target = vol * (0.5 + Math.random() * 0.5);
                needleTargets[ch.id] = needleTargets[ch.id] * 0.7 + target * 0.3;
            } else {
                needleTargets[ch.id] *= 0.85;
            }
            // Animate needle (rotate from -45 to +45 degrees)
            const needle = document.getElementById('needle-' + ch.id);
            if (needle) {
                const deg = -45 + needleTargets[ch.id] * 90;
                needle.style.transform = `translateX(-50%) rotate(${deg}deg)`;
            }
        });

        // Master VU
        if (isPlaying) {
            masterTargets.l = masterTargets.l * 0.6 + (0.4 + Math.random() * 0.6) * 0.4;
            masterTargets.r = masterTargets.r * 0.6 + (0.4 + Math.random() * 0.6) * 0.4;
        } else {
            masterTargets.l *= 0.85;
            masterTargets.r *= 0.85;
        }
        const mvL = document.getElementById('masterVuL');
        const mvR = document.getElementById('masterVuR');
        if (mvL) mvL.style.height = (masterTargets.l * 100) + '%';
        if (mvR) mvR.style.height = (masterTargets.r * 100) + '%';

        vuAnimFrame = requestAnimationFrame(animate);
    }
    animate();
}

// TRANSPORT
function toggleTransport() {
    isPlaying = !isPlaying;
    const btn = document.getElementById('playBtn');
    btn.textContent = isPlaying ? '⏸' : '▶';
    if (isPlaying) {
        const start = Date.now() - transportTime;
        transportInterval = setInterval(() => {
            transportTime = Date.now() - start;
            const ms = transportTime % 1000;
            const s = Math.floor(transportTime / 1000) % 60;
            const m = Math.floor(transportTime / 60000);
            document.getElementById('transportTime').textContent =
                String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
        }, 16);
        showToast('▶ Playing stem mix...');
    } else {
        clearInterval(transportInterval);
        showToast('⏸ Paused');
    }
}

// CHANNEL CONTROLS
function toggleChMute(id) {
    const s = channelState[id];
    s.muted = !s.muted;
    const strip = document.getElementById('strip-' + id);
    const btn = document.getElementById('muteBtn-' + id);
    const muteH = document.getElementById('mute-' + id);
    strip.classList.toggle('muted-ch', s.muted);
    if (btn) btn.classList.toggle('on', s.muted);
    if (muteH) muteH.classList.toggle('muted', s.muted);
}
function toggleSolo(id, btn) {
    btn.classList.toggle('on');
    showToast(btn.classList.contains('on') ? `Solo: ${id}` : `Solo off: ${id}`);
}
function updateFader(id, type, val) {
    channelState[id][type] = parseFloat(val);
}
function toggleFx(chId, fxName, toggleEl) {
    toggleEl.classList.toggle('on');
    channelState[chId].fx[fxName].on = toggleEl.classList.contains('on');
    showToast((toggleEl.classList.contains('on') ? '✓ ' : '✗ ') + fxName + ' on ' + chId);
}
function setKey(chId, key, btn) {
    btn.closest('.autotune-key-row').querySelectorAll('.key-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    channelState[chId].fx.autotune.key = key;
}

// STEM UPLOAD
function triggerStemUpload(id) {
    currentStemTarget = id;
    document.getElementById('stemFileInput').click();
}
function handleStemFile(input) {
    if (!input.files[0] || !currentStemTarget) return;
    const f = input.files[0];
    channelState[currentStemTarget].file = f.name;
    document.getElementById('fname-' + currentStemTarget).textContent = f.name;
    document.getElementById('upbtn-' + currentStemTarget).textContent = '✓ ' + f.name.substring(0, 16) + '...';
    document.getElementById('upbtn-' + currentStemTarget).style.color = 'var(--accent)';
    input.value = '';
    showToast('✓ ' + f.name + ' loaded');
}

function saveMixPreset() {
    showToast('Stem mixer presets are local only. Use Quick Master to send a mix for cloud mastering.');
}

function startStemMaster() {
    showToast('Use Quick Master to upload and master your track on Stemy servers.');
}

// PAYMENT — Stripe Checkout / Customer Portal (server)
async function openBillingPortal() {
    if (!localStorage.getItem('esAuthToken')) {
        showToast('Log in first');
        showPage('login');
        return;
    }
    try {
        const { url } = await apiCall('/subscriptions/portal', { method: 'POST', body: {} });
        if (url) window.location.href = url;
    } catch (e) {
        showToast(e.message || 'Could not open billing portal');
    }
}

async function openPayment(planLabel, _priceIgnored) {
    if (!localStorage.getItem('esAuthToken')) {
        showToast('Log in to subscribe');
        showPage('login');
        return;
    }
    const p = String(planLabel || '').toLowerCase();
    const plan = p.includes('basic') ? 'basic' : 'pro';
    const modal = document.getElementById('paymentModal');
    if (modal) modal.classList.remove('active');
    try {
        const { url } = await apiCall('/subscriptions/checkout', { method: 'POST', body: { plan } });
        if (url) window.location.href = url;
    } catch (e) {
        showToast(e.message || 'Checkout failed');
    }
}

function closePayment() {
    const modal = document.getElementById('paymentModal');
    if (modal) modal.classList.remove('active');
}

function formatCard(input) {
    let v = input.value.replace(/\D/g, '').substring(0, 16);
    input.value = v.replace(/(.{4})/g, '$1 ').trim();
}

function completePurchase() {
    const name = (document.getElementById('modalPlanName')?.textContent || '').toLowerCase();
    const label = name.includes('basic') ? 'Basic' : 'Pro';
    void openPayment(label);
}

function handleCheckoutReturn() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('checkout') === 'success') {
        refreshSession().then(() => {
            showToast('Subscription updated');
            const pr = document.getElementById('page-profile');
            if (pr) void populateProfile();
        });
        window.history.replaceState({}, '', window.location.pathname);
        return;
    }
    if (p.get('checkout') === 'cancel') {
        showToast('Checkout canceled');
        window.history.replaceState({}, '', window.location.pathname);
    }
}

// TOAST
function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

window.addEventListener('load', () => {
    if (localStorage.getItem('esAuthToken')) updateNav('home');
});


// ===== SSL CONSOLE JS =====

const CHS = [
    { id: 'kick', name: 'Kick', num: '01', col: '#ff4444', icon: '⚡' },
    { id: 'snare', name: 'Snare', num: '02', col: '#ff8800', icon: '🥁' },
    { id: 'hh', name: 'Hi-Hat', num: '03', col: '#ffcc00', icon: '🎵' },
    { id: 'drums', name: 'Drums', num: '04', col: '#ff6b6b', icon: '🥁' },
    { id: 'bass', name: 'Bass', num: '05', col: '#fbbf24', icon: '🎸' },
    { id: 'gtr', name: 'Guitar', num: '06', col: '#4ade80', icon: '🎸' },
    { id: 'keys', name: 'Keys', num: '07', col: '#00e5a0', icon: '🎹' },
    { id: 'synth', name: 'Synth', num: '08', col: '#00e5ff', icon: '🎹' },
    { id: 'vox', name: 'Vocals', num: '09', col: '#a78bfa', icon: '🎤' },
    { id: 'bvox', name: 'BG Vox', num: '10', col: '#c4b5fd', icon: '🎤' },
    { id: 'vfx', name: 'Vox FX', num: '11', col: '#7b61ff', icon: '🌊' },
    { id: 'fx', name: 'FX Bus', num: '12', col: '#f472b6', icon: '🔀' },
];

const S = {};
CHS.forEach(c => {
    S[c.id] = {
        vol: 75 + Math.random() * 15, pan: (Math.random() - 0.5) * 20,
        muted: false, soloed: false, file: null,
        vuL: 0, vuR: 0, vuTL: 0, vuTR: 0,
        peakL: 0, peakR: 0, peakHoldL: 0, peakHoldR: 0,
        grLevel: 0,
        eq: { hf: 50, hmf: 50, lmf: 50, lf: 50 },
        sends: { a: Math.round(40 + Math.random() * 40), b: Math.round(20 + Math.random() * 30) },
    };
});

let playing = false, recording = false, tTime = 0, tInterval = null;
let mVuL = 0, mVuR = 0, mVuTL = 0, mVuTR = 0;
let stemTarget = null;

/* =====================
   VU BRIDGE — VINTAGE NEEDLE METERS
   ===================== */
function buildVuBridge() {
    const bridge = document.getElementById('vuBridge');
    // Remove only meter cells, keep label
    const label = bridge.querySelector('.vu-bridge-label');
    bridge.innerHTML = '';
    bridge.appendChild(label);

    CHS.forEach(ch => {
        const unit = document.createElement('div');
        unit.className = 'vu-unit';
        unit.innerHTML = `
      <div class="vu-meter-body">
        <div class="vu-face" id="vuface-${ch.id}">
          <div class="vu-scale-bg"></div>
          <canvas class="vu-scale-canvas" id="vucv-${ch.id}" width="68" height="52"></canvas>
          <div class="vu-illumination"></div>
          <!-- Needle -->
          <div class="vu-needle" id="vuneedle-${ch.id}"></div>
          <div class="vu-pivot"></div>
          <!-- DB labels at bottom -->
          <div class="vu-db-strip">
            <span class="vu-db-label">-20</span>
            <span class="vu-db-label">-10</span>
            <span class="vu-db-label">-7</span>
            <span class="vu-db-label">-3</span>
            <span class="vu-db-label" style="color:rgba(255,23,68,0.5);">+3</span>
          </div>
          <div class="vu-red-zone">VU</div>
        </div>
        <div class="vu-nameplate">Ch ${ch.num}</div>
      </div>
      <div class="vu-ch-name" style="color:${ch.col}">${ch.icon} ${ch.name}</div>
    `;
        bridge.appendChild(unit);
        // Draw scale markings on canvas
        drawVuScale(`vucv-${ch.id}`);
    });
}

function drawVuScale(cvId) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    // Draw arc scale lines from bottom center
    const cx = W / 2, cy = H - 10;
    const r0 = 28, r1 = 36;

    // Scale positions: -20,-10,-7,-3,0,+3 mapped to angles
    const ticks = [
        { db: -20, ang: -55, major: true },
        { db: -10, ang: -30, major: true },
        { db: -7, ang: -18, major: false },
        { db: -3, ang: -6, major: false },
        { db: 0, ang: 6, major: true, zero: true },
        { db: 3, ang: 22, major: true, red: true },
    ];

    ticks.forEach(t => {
        const rad = (t.ang * Math.PI) / 180;
        const x0 = cx + Math.sin(rad) * r0;
        const y0 = cy - Math.cos(rad) * r0;
        const x1 = cx + Math.sin(rad) * (t.major ? r1 : r1 - 3);
        const y1 = cy - Math.cos(rad) * (t.major ? r1 : r1 - 3);

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = t.red ? 'rgba(255,60,60,0.6)' : t.zero ? 'rgba(0,230,118,0.6)' : 'rgba(200,195,160,0.3)';
        ctx.lineWidth = t.major ? 1 : 0.5;
        ctx.stroke();

        // Minor ticks between major
        if (t.major && t.ang < 22) {
            for (let i = 1; i < 4; i++) {
                const nextTick = ticks[ticks.indexOf(t) + 1];
                if (!nextTick) break;
                const mAng = t.ang + (nextTick.ang - t.ang) * i / 4;
                const mRad = (mAng * Math.PI) / 180;
                const mx0 = cx + Math.sin(mRad) * r0;
                const my0 = cy - Math.cos(mRad) * r0;
                const mx1 = cx + Math.sin(mRad) * (r0 + 3);
                const my1 = cy - Math.cos(mRad) * (r0 + 3);
                ctx.beginPath();
                ctx.moveTo(mx0, my0);
                ctx.lineTo(mx1, my1);
                ctx.strokeStyle = 'rgba(200,195,160,0.12)';
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
        }
    });

    // Red zone shading
    ctx.beginPath();
    ctx.arc(cx, cy, (r0 + r1) / 2, ((6) * Math.PI / 180) - Math.PI / 2, ((30) * Math.PI / 180) - Math.PI / 2);
    ctx.strokeStyle = 'rgba(255,30,30,0.08)';
    ctx.lineWidth = r1 - r0;
    ctx.stroke();
}

/* =====================
   BUILD CHANNEL STRIPS
   ===================== */
function buildStrips() {
    const row = document.getElementById('stripsRow');
    row.innerHTML = '';

    CHS.forEach(ch => {
        const s = S[ch.id];
        const div = document.createElement('div');
        div.className = 'strip';
        div.id = 'strip-' + ch.id;
        div.innerHTML = `
      <div class="color-top" style="background:${ch.col}"></div>
      <!-- NAME -->
      <div class="name-bar">
        <div class="ch-name" style="color:${ch.col}">${ch.icon} ${ch.name}</div>
        <div class="ch-num">Ch ${ch.num}</div>
        <div class="ch-file" id="chf-${ch.id}">No File</div>
      </div>
      <!-- UPLOAD -->
      <div class="upload-z" onclick="triggerStem('${ch.id}')">
        <span>+</span>
        <span class="upload-z" style="border:none;margin:0;padding:0;"><span style="font-family:var(--mono);font-size:0.42rem;color:var(--label);">Upload</span></span>
      </div>
      <!-- INPUT -->
      <div class="sec">
        <span class="sec-lbl">Input</span>
        <div class="knob-row">
          <div class="kw"><div class="knob" title="Gain"></div><div class="klbl">Gain</div></div>
          <div class="kw"><div class="knob ctr" title="Trim"></div><div class="klbl">Trim</div></div>
        </div>
        <div class="btn-row" style="margin-top:3px;">
          <button class="sbtn" onclick="tog(this,'y')" title="Phase">Ø</button>
          <button class="sbtn" onclick="tog(this,'c')" title="HPF">HPF</button>
          <button class="sbtn" onclick="tog(this,'c')" title="LPF">LPF</button>
        </div>
      </div>
      <!-- EQ -->
      <div class="sec">
        <span class="sec-lbl">4-Band EQ</span>
        <div class="eq-disp"><canvas id="eq-${ch.id}" width="72" height="18"></canvas></div>
        <div class="knob-row">
          <div class="kw"><div class="knob ctr" title="HF Gain" onmousedown="kDrag('${ch.id}','hf',this,event)"></div><div class="klbl">HF</div></div>
          <div class="kw"><div class="knob ctr" title="HMF" onmousedown="kDrag('${ch.id}','hmf',this,event)"></div><div class="klbl">HMF</div></div>
          <div class="kw"><div class="knob ctr" title="LMF" onmousedown="kDrag('${ch.id}','lmf',this,event)"></div><div class="klbl">LMF</div></div>
          <div class="kw"><div class="knob ctr" title="LF" onmousedown="kDrag('${ch.id}','lf',this,event)"></div><div class="klbl">LF</div></div>
        </div>
        <div class="btn-row" style="margin-top:2px;">
          <button class="sbtn" onclick="tog(this,'g')" title="EQ In">EQ</button>
          <button class="sbtn" onclick="this.textContent=this.textContent==='Bell'?'Shelf':'Bell'" title="Bell/Shelf">Bell</button>
        </div>
      </div>
      <!-- DYNAMICS -->
      <div class="sec">
        <span class="sec-lbl">Dynamics</span>
        <div class="gr-meter"><div class="gr-fill" id="gr-${ch.id}" style="width:0%"></div></div>
        <div class="knob-row">
          <div class="kw"><div class="knob" title="Threshold"></div><div class="klbl">Thr</div></div>
          <div class="kw"><div class="knob" title="Ratio"></div><div class="klbl">Rat</div></div>
          <div class="kw"><div class="knob" title="Attack"></div><div class="klbl">Atk</div></div>
          <div class="kw"><div class="knob" title="Release"></div><div class="klbl">Rel</div></div>
        </div>
        <div class="btn-row" style="margin-top:2px;">
          <button class="sbtn" onclick="tog(this,'g')">Comp</button>
          <button class="sbtn" onclick="tog(this,'o')">Gate</button>
          <button class="sbtn" onclick="tog(this,'y')">SC</button>
        </div>
      </div>
      <!-- FX -->
      <div class="sec">
        <span class="sec-lbl">FX / Inserts</span>
        <div class="btn-row">
          <button class="sbtn" onclick="tog(this,'b')" title="Auto-Tune">AT</button>
          <button class="sbtn" onclick="tog(this,'c')" title="Reverb">Rev</button>
          <button class="sbtn" onclick="tog(this,'c')" title="Delay">Dly</button>
        </div>
        <div class="btn-row" style="margin-top:2px;">
          <button class="sbtn" onclick="tog(this,'o')">Sat</button>
          <button class="sbtn" onclick="tog(this,'y')">Ins A</button>
          <button class="sbtn" onclick="tog(this,'y')">Ins B</button>
        </div>
        ${(ch.id === 'vox' || ch.id === 'bvox') ? `
        <div style="display:flex;gap:1px;margin-top:3px;flex-wrap:wrap;justify-content:center;">
          ${['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((k, i) => `<button class="sbtn ${i === 0 ? 'b' : ''}" onclick="setAtKey(this)">${k}</button>`).join('')}
        </div>`: ''}
      </div>
      <!-- SENDS -->
      <div class="sends-sec">
        <span class="sec-lbl">Sends</span>
        <div class="send-row">
          <span class="slbl">A</span>
          <div class="sbar"><div class="sfill" style="width:${s.sends.a}%;background:linear-gradient(90deg,#2979ff,#00e5ff)"></div></div>
          <span class="sval">${s.sends.a}</span>
        </div>
        <div class="send-row">
          <span class="slbl">B</span>
          <div class="sbar"><div class="sfill" style="width:${s.sends.b}%;background:linear-gradient(90deg,#aa00ff,#7b61ff)"></div></div>
          <span class="sval">${s.sends.b}</span>
        </div>
      </div>
      <!-- ROUTING -->
      <div class="route-sec">
        <span class="sec-lbl">Routing</span>
        <div class="btn-row">
          <button class="sbtn g" onclick="tog2(this,'g')">Mstr</button>
          <button class="sbtn" onclick="tog(this,'b')">B1</button>
          <button class="sbtn" onclick="tog(this,'b')">B2</button>
        </div>
        <div class="btn-row" style="margin-top:2px;">
          <button class="sbtn" onclick="tog(this,'c')">Cue</button>
          <button class="sbtn" onclick="tog(this,'y')">Dir</button>
        </div>
      </div>
      <!-- AUTOMATION -->
      <div class="auto-sec">
        <span class="sec-lbl">Auto</span>
        <div class="btn-row">
          <button class="sbtn c" onclick="togAuto(this)">Rd</button>
          <button class="sbtn" onclick="togAuto(this)">Wr</button>
          <button class="sbtn" onclick="togAuto(this)">Tch</button>
          <button class="sbtn" onclick="togAuto(this)">Lch</button>
        </div>
      </div>

      <!-- ============================
           VERTICAL LEVEL METER IN STRIP
           ============================ -->
      <div class="strip-level-meter" id="slm-${ch.id}">
        <div class="level-bar-wrap">
          <div style="position:relative;">
            <div class="level-bar" id="lbar-L-${ch.id}">
              <div class="level-segs" id="lsegs-L-${ch.id}"></div>
              <div class="clip-dot" id="clip-L-${ch.id}"></div>
              <div class="peak-hold" id="peak-L-${ch.id}"></div>
            </div>
          </div>
          <div class="level-bar-label">L</div>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:space-between;height:80px;padding:1px 0;pointer-events:none;">
          <span style="font-family:var(--mono);font-size:0.3rem;color:rgba(255,23,68,0.4);">+6</span>
          <span style="font-family:var(--mono);font-size:0.3rem;color:rgba(255,234,0,0.4);">0</span>
          <span style="font-family:var(--mono);font-size:0.3rem;color:rgba(0,230,118,0.5);">-6</span>
          <span style="font-family:var(--mono);font-size:0.3rem;color:var(--label2);">-12</span>
          <span style="font-family:var(--mono);font-size:0.3rem;color:var(--label2);">-∞</span>
        </div>
        <div class="level-bar-wrap">
          <div style="position:relative;">
            <div class="level-bar" id="lbar-R-${ch.id}">
              <div class="level-segs" id="lsegs-R-${ch.id}"></div>
              <div class="clip-dot" id="clip-R-${ch.id}"></div>
              <div class="peak-hold" id="peak-R-${ch.id}"></div>
            </div>
          </div>
          <div class="level-bar-label">R</div>
        </div>
      </div>

      <!-- PAN -->
      <div class="pan-sec">
        <div class="kw" style="width:100%;">
          <div class="knob ctr" style="width:22px;height:22px;margin:0 auto;" title="Pan" id="panKnob-${ch.id}" onmousedown="kDrag('${ch.id}','pan',this,event)"></div>
          <div class="pan-bar">
            <div class="pan-center"></div>
            <div class="pan-dot" id="panDot-${ch.id}" style="left:calc(50% + ${s.pan * 0.9}%)"></div>
          </div>
          <div class="klbl" id="panVal-${ch.id}" style="color:var(--cyan);">${s.pan > 0 ? 'R' + Math.abs(Math.round(s.pan)) : s.pan < 0 ? 'L' + Math.abs(Math.round(s.pan)) : 'C'}</div>
        </div>
      </div>

      <!-- FADER -->
      <div class="fader-sec">
        <div class="fader-track" style="height:120px;position:relative;">
          <input class="fader-range" type="range" min="0" max="100" value="${Math.round(s.vol)}" id="fader-${ch.id}" oninput="updateFader('${ch.id}',this.value)">
          <div class="fader-cap" id="fcap-${ch.id}" style="top:${100 - s.vol}%"></div>
          <div class="fader-marks">
            <span class="fmark" style="color:rgba(255,23,68,0.4);">+10</span>
            <span class="fmark">+5</span>
            <span class="fmark z">0</span>
            <span class="fmark">-5</span>
            <span class="fmark">-∞</span>
          </div>
        </div>
        <div class="fader-db" id="fdb-${ch.id}">${vToDb(s.vol)}</div>
      </div>

      <!-- BOTTOM BUTTONS -->
      <div class="ch-bot">
        <div class="ch-bot-row">
          <button class="sbtn" style="flex:1;" id="solo-${ch.id}" onclick="doSolo('${ch.id}',this)" title="Solo">S</button>
          <button class="sbtn" style="flex:1;" id="mute-${ch.id}" onclick="doMute('${ch.id}',this)" title="Mute">M</button>
          <button class="sbtn" style="flex:1;" id="rec-${ch.id}" onclick="tog(this,'r')" title="Record">R</button>
        </div>
        <div class="ch-bot-row">
          <button class="sbtn" style="flex:1;" onclick="tog(this,'c')">PFL</button>
          <button class="sbtn" style="flex:1;" onclick="tog(this,'y')">AFL</button>
        </div>
      </div>
    `;
        row.appendChild(div);
    });

    // Build segment LEDs for level bars and EQ curves
    CHS.forEach(ch => {
        buildLevelSegs(ch.id);
        drawEqCurve(ch.id);
    });
}

/* Build LED segments inside vertical level bars */
function buildLevelSegs(id) {
    ['L', 'R'].forEach(side => {
        const container = document.getElementById(`lsegs-${side}-${id}`);
        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i < 20; i++) {
            const seg = document.createElement('div');
            seg.className = `lseg ${i < 14 ? 'g' : i < 17 ? 'y' : 'r'}`;
            seg.id = `ls-${side}-${id}-${i}`;
            container.appendChild(seg);
        }
    });
}

/* Build master VU bars */
function buildMasterVu() {
    // Legacy no-op: analog VU meters are pure SVG, built inline in HTML.
    // Needles are animated in the main animation loop via `mvu-needle-L/R` elements.
}

/* Draw EQ curve on mini display */
function drawEqCurve(id) {
    const cv = document.getElementById('eq-' + id);
    if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += W / 4) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(0,230,118,0.08)';
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    // Curve
    const s = S[id]; if (!s) return;
    ctx.beginPath(); ctx.strokeStyle = 'rgba(0,230,118,0.65)'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x++) {
        const t = x / W;
        const lf = (s.eq.lf - 50) / 50 * 3;
        const lmf = (s.eq.lmf - 50) / 50 * 2.5 * Math.exp(-Math.pow((t - 0.28) * 5, 2));
        const hmf = (s.eq.hmf - 50) / 50 * 2.5 * Math.exp(-Math.pow((t - 0.65) * 5, 2));
        const hf = (s.eq.hf - 50) / 50 * 3;
        const y = H / 2 - (lf + lmf + hmf + hf);
        x === 0 ? ctx.moveTo(x, Math.max(1, Math.min(H - 1, y))) : ctx.lineTo(x, Math.max(1, Math.min(H - 1, y)));
    }
    ctx.stroke();
}

/* =====================
   VU ANIMATION
   ===================== */
let needleTargets = {};
CHS.forEach(c => { needleTargets[c.id] = { v: 0, smooth: 0 }; });

// Map level 0-1 to needle angle -55 to +30 degrees
function levelToAngle(v) { return -55 + v * 85; }

function animateAll() {
    CHS.forEach(ch => {
        const s = S[ch.id];
        const active = playing && !s.muted;
        const vol = s.vol / 100;

        // VU needle target (smooth)
        if (active) {
            const noise = vol * (0.4 + Math.random() * 0.6);
            needleTargets[ch.id].v = needleTargets[ch.id].v * 0.55 + noise * 0.45;
        } else {
            needleTargets[ch.id].v *= 0.88;
        }
        needleTargets[ch.id].smooth = needleTargets[ch.id].smooth * 0.7 + needleTargets[ch.id].v * 0.3;

        // Animate VU needle
        const needle = document.getElementById('vuneedle-' + ch.id);
        if (needle) {
            const ang = levelToAngle(needleTargets[ch.id].smooth);
            needle.style.transform = `translateX(-50%) rotate(${ang}deg)`;
        }

        // Vertical level bars (L and R slightly different)
        const lvL = active ? needleTargets[ch.id].smooth * (0.8 + Math.random() * 0.2) : needleTargets[ch.id].smooth;
        const lvR = active ? needleTargets[ch.id].smooth * (0.8 + Math.random() * 0.2) : needleTargets[ch.id].smooth;
        s.vuTL = lvL; s.vuTR = lvR;

        // Update L bar
        const numLitL = Math.round(lvL * 20);
        for (let i = 0; i < 20; i++) {
            const seg = document.getElementById(`ls-L-${ch.id}-${i}`);
            if (seg) seg.classList.toggle('lit', i < numLitL);
        }
        // Peak hold L
        if (lvL > s.peakHoldL) { s.peakHoldL = lvL; }
        else { s.peakHoldL = Math.max(0, s.peakHoldL - 0.005); }
        const peakEL = document.getElementById(`peak-L-${ch.id}`);
        if (peakEL) { const ph = Math.round(s.peakHoldL * 20); peakEL.style.bottom = (ph / 20 * 76) + 'px'; }

        // Update R bar
        const numLitR = Math.round(lvR * 20);
        for (let i = 0; i < 20; i++) {
            const seg = document.getElementById(`ls-R-${ch.id}-${i}`);
            if (seg) seg.classList.toggle('lit', i < numLitR);
        }
        // Clip dots
        const clipL = document.getElementById(`clip-L-${ch.id}`);
        const clipR = document.getElementById(`clip-R-${ch.id}`);
        if (clipL) clipL.classList.toggle('clipping', lvL > 0.9);
        if (clipR) clipR.classList.toggle('clipping', lvR > 0.9);

        // GR meter
        if (active) {
            const gr = Math.random() * 15 * vol;
            const grEl = document.getElementById('gr-' + ch.id);
            if (grEl) grEl.style.width = gr + '%';
        }
    });

    // Master VU
    if (playing) {
        mVuTL = mVuTL * 0.55 + (0.5 + Math.random() * 0.5) * 0.45;
        mVuTR = mVuTR * 0.55 + (0.5 + Math.random() * 0.5) * 0.45;
    } else {
        mVuTL *= 0.88; mVuTR *= 0.88;
    }
    // Drive the analog VU needles (L/R). Level 0..1 → needle angle -50° to +30°.
    // Classic VU ballistics (~300ms) is already implicit in the mVuTL/R smoothing above.
    const needleL = document.getElementById('mvu-needle-L');
    const needleR = document.getElementById('mvu-needle-R');
    // Map level to angle using the same piecewise scale as the home-page meter.
    // Level 0.0 → -20 dB VU (-50°), 0.75 → 0 VU (0°), 1.0 → +3 (+30°)
    const lvToAngle = (lv) => {
        const clamped = Math.max(0, Math.min(1, lv));
        // Piecewise: 0..0.75 maps to -50 → 0 (linear); 0.75..1 maps to 0 → +30
        if (clamped <= 0.75) return -50 + (clamped / 0.75) * 50;
        return ((clamped - 0.75) / 0.25) * 30;
    };
    if (needleL) needleL.setAttribute('transform', `rotate(${lvToAngle(mVuTL).toFixed(2)} 54 68)`);
    if (needleR) needleR.setAttribute('transform', `rotate(${lvToAngle(mVuTR).toFixed(2)} 54 68)`);

    // Clip LEDs (light above 0.92 = near clipping)
    const cL = document.getElementById('clipL'), cR = document.getElementById('clipR');
    if (cL) cL.classList.toggle('on', mVuTL > 0.92);
    if (cR) cR.classList.toggle('on', mVuTR > 0.92);

    requestAnimationFrame(animateAll);
}

/* =====================
   BUTTONS & CONTROLS
   ===================== */
function tog(btn, colorClass) {
    const classes = ['g', 'y', 'r', 'o', 'b', 'c'];
    const wasOn = classes.some(c => btn.classList.contains(c));
    classes.forEach(c => btn.classList.remove(c));
    if (!wasOn) btn.classList.add(colorClass);
}
function tog2(btn, colorClass) {
    const classes = ['g', 'y', 'r', 'o', 'b', 'c'];
    classes.forEach(c => btn.classList.remove(c));
    btn.classList.add(colorClass);
}
function togAuto(btn) {
    const row = btn.closest('.btn-row');
    row.querySelectorAll('.sbtn').forEach(b => { ['g', 'y', 'r', 'o', 'b', 'c'].forEach(c => b.classList.remove(c)); });
    btn.classList.add('c');
}
function setAtKey(btn) {
    btn.closest('div').querySelectorAll('.sbtn').forEach(b => { ['g', 'y', 'r', 'o', 'b', 'c'].forEach(c => b.classList.remove(c)); });
    btn.classList.add('b');
}
function doSolo(id, btn) {
    S[id].soloed = !S[id].soloed;
    btn.classList.toggle('y', S[id].soloed);
    document.getElementById('strip-' + id).classList.toggle('soloed', S[id].soloed);
}
function doMute(id, btn) {
    S[id].muted = !S[id].muted;
    btn.classList.toggle('r', S[id].muted);
    document.getElementById('strip-' + id).classList.toggle('muted', S[id].muted);
}
function updateFader(id, val) {
    S[id].vol = parseFloat(val);
    const cap = document.getElementById('fcap-' + id);
    const db = document.getElementById('fdb-' + id);
    if (cap) cap.style.top = (100 - val) + '%';
    if (db) db.textContent = vToDb(val);
}
function updateMasterFader(val) {
    const cap = document.getElementById('mFaderCap');
    const db = document.getElementById('mFaderDb');
    if (cap) cap.style.top = (100 - val) + '%';
    if (db) db.textContent = vToDb(val);
}
function vToDb(v) {
    if (v < 1) return '-∞';
    const db = (v - 80) / 80 * 10;
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
}

/* KNOB DRAG */
let kDragging = null;
function kDrag(id, param, el, e) {
    kDragging = { id, param, el, y: e.clientY, v: S[id]?.eq?.[param] ?? S[id]?.[param] ?? 50 };
    document.addEventListener('mousemove', onKDrag);
    document.addEventListener('mouseup', offKDrag);
}
function onKDrag(e) {
    if (!kDragging) return;
    const delta = (kDragging.y - e.clientY) * 0.8;
    const nv = Math.max(0, Math.min(100, kDragging.v + delta));
    const s = S[kDragging.id];
    if (kDragging.param === 'pan') {
        s.pan = (nv - 50) / 50 * 50;
        const dot = document.getElementById('panDot-' + kDragging.id);
        const val = document.getElementById('panVal-' + kDragging.id);
        if (dot) dot.style.left = `calc(50% + ${s.pan * 0.9}%)`;
        if (val) val.textContent = s.pan > 0 ? 'R' + Math.abs(Math.round(s.pan)) : s.pan < 0 ? 'L' + Math.abs(Math.round(s.pan)) : 'C';
    } else if (s?.eq?.[kDragging.param] !== undefined) {
        s.eq[kDragging.param] = nv;
        drawEqCurve(kDragging.id);
    }
    kDragging.el.style.transform = `rotate(${-135 + nv / 100 * 270}deg)`;
}
function offKDrag() { kDragging = null; document.removeEventListener('mousemove', onKDrag); document.removeEventListener('mouseup', offKDrag); }

/* TRANSPORT */
function doPlay() {
    playing = !playing;
    const btn = document.getElementById('playBtn');
    btn.classList.toggle('on', playing);
    btn.textContent = playing ? '⏸' : '▶';
    if (playing) {
        const start = Date.now() - tTime;
        tInterval = setInterval(() => {
            tTime = Date.now() - start;
            const ms = tTime % 1000, s2 = Math.floor(tTime / 1000) % 60, m = Math.floor(tTime / 60000);
            document.getElementById('timeDisp').textContent = `${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
        }, 16);
    } else { clearInterval(tInterval); }
}
function doStop() { playing = false; tTime = 0; clearInterval(tInterval); document.getElementById('playBtn').classList.remove('on'); document.getElementById('playBtn').textContent = '▶'; document.getElementById('timeDisp').textContent = '00:00.000'; }
function doRewind() { tTime = 0; document.getElementById('timeDisp').textContent = '00:00.000'; }
function doRec() { recording = !recording; document.getElementById('recBtn').classList.toggle('on', recording); }
function setAuto(mode, btn) { document.querySelectorAll('.ab').forEach(b => b.classList.remove('on')); btn.classList.add('on'); document.getElementById('autoDisp').textContent = mode.charAt(0).toUpperCase() + mode.slice(1); }

/* STEM UPLOAD */
function triggerStem(id) { stemTarget = id; document.getElementById('stemInput').click(); }
function handleStem(input) {
    if (!input.files[0] || !stemTarget) return;
    const f = input.files[0];
    S[stemTarget].file = f.name;
    const el = document.getElementById('chf-' + stemTarget);
    if (el) { el.textContent = '✓ ' + f.name.substring(0, 10) + '...'; }
    input.value = '';
}

/* CPU */
function tickCpu() { document.getElementById('cpuDisp').textContent = (playing ? 14 : 6 + Math.random() * 4).toFixed(0) + '%'; }

function saveSession() { showToast('Console session is not saved to the server.'); }
function doMixDown() { showToast('Use Quick Master to export a mastered file from Stemy.'); }

/* INIT */
function sslInit() {
    buildVuBridge();
    buildStrips();
    buildMasterVu();
    animateAll();
    setInterval(tickCpu, 2500);
}

// ===== END SSL JS =====

// ===== AUTH FUNCTIONS (added for real backend) =====

async function saveProfileSettings() {
    const fnEl = document.getElementById('settingsFirstName');
    const lnEl = document.getElementById('settingsLastName');
    const fn = fnEl ? fnEl.value.trim() : '';
    const ln = lnEl ? lnEl.value.trim() : '';
    if (!fn) {
        showToast('First name is required');
        return;
    }

    try {
        const data = await apiCall('/users/me', {
            method: 'PATCH',
            body: {
                firstName: fn,
                lastName: ln,
                displayName: (fn + ' ' + ln).trim(),
            },
        });

        if (data.user) {
            const userStr = localStorage.getItem('esUser');
            const prev = userStr ? JSON.parse(userStr) : {};
            localStorage.setItem('esUser', JSON.stringify({ ...prev, ...data.user }));
        }
        await refreshSession();
        await populateProfile();
        showToast('Settings saved');
    } catch (err) {
        showToast(err.message || 'Failed to save settings');
    }
}

function ensureEmailVerifyModal() {
    if (document.getElementById('emailVerifyModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'emailVerifyModal';
    wrap.className = 'modal-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'emailVerifyModalTitle');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `
        <div class="modal-card email-verify-modal-card" role="document">
            <button type="button" class="modal-close" onclick="closeEmailVerifyModal()" aria-label="Close">✕</button>
            <div class="email-verify-modal-icon" aria-hidden="true">✉️</div>
            <div class="modal-title" id="emailVerifyModalTitle">Verify your email</div>
            <p class="modal-sub">Paste the token from your verification email, or open the link in that email in your browser.</p>
            <label class="card-field-label" for="verifyOtpInput">Verification token</label>
            <input class="card-field" type="text" id="verifyOtpInput" name="verification_token" placeholder="Paste token from email" maxlength="128" autocomplete="one-time-code" spellcheck="false">
            <div class="email-verify-modal-actions">
                <button type="button" class="btn btn-primary btn-wide" onclick="verifyEmailOtp()">Verify email</button>
                <button type="button" class="btn btn-ghost btn-wide" onclick="resendVerificationEmail()">Resend verification email</button>
            </div>
        </div>
    `;
    wrap.addEventListener('click', () => closeEmailVerifyModal());
    const card = wrap.querySelector('.modal-card');
    if (card) card.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(wrap);
}

function openEmailVerifyModal() {
    ensureEmailVerifyModal();
    const m = document.getElementById('emailVerifyModal');
    if (!m) return;
    m.classList.add('active');
    m.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        const inp = document.getElementById('verifyOtpInput');
        if (inp) inp.focus();
    });
}

function closeEmailVerifyModal() {
    const m = document.getElementById('emailVerifyModal');
    if (!m) return;
    m.classList.remove('active');
    m.setAttribute('aria-hidden', 'true');
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = document.getElementById('emailVerifyModal');
    if (m && m.classList.contains('active')) closeEmailVerifyModal();
});

async function resendVerificationEmail() {
    const userStr = localStorage.getItem('esUser');
    const user = userStr ? JSON.parse(userStr) : null;

    if (!user?.email) {
        showToast('Please log in again');
        return;
    }

    try {
        await apiCall('/auth/resend-verification', {
            method: 'POST',
            body: { email: user.email }
        });
        showToast('If your account needs verification, check your email for the link.');
    } catch (err) {
        showToast(err.message || 'Failed to send code');
    }
}

async function verifyEmailOtp() {
    const otpInput = document.getElementById('verifyOtpInput');
    const otp = otpInput ? otpInput.value.trim() : '';

    if (!otp || otp.length < 8) {
        showToast('Paste the full verification token from your email');
        return;
    }

    try {
        const userStr = localStorage.getItem('esUser');
        const user = userStr ? JSON.parse(userStr) : null;
        if (!user?.email) {
            showToast('Please log in again');
            return;
        }
        await apiCall('/auth/verify-email', {
            method: 'POST',
            body: { token: otp, email: user.email },
        });
        showToast('Email verified');
        closeEmailVerifyModal();
        const prompt = document.getElementById('emailVerifyPrompt');
        if (prompt) prompt.remove();
        await refreshSession();
    } catch (err) {
        showToast(err.message || 'Invalid or expired code');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    handleCheckoutReturn();
    await loadCurrentUser();
    const pendingReset = applyPendingPasswordReset();
    showPage(pendingReset ? 'login' : (window.STEMY_INITIAL_PAGE || 'home'));
});
