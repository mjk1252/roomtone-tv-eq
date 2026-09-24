const PRESETS = {
  3: { centers: [125, 1000, 8000], labels: ['Bass', 'Mid', 'Treble'] },
  5: { centers: [100, 300, 1000, 3000, 10000], labels: ['100 Hz', '300 Hz', '1 kHz', '3 kHz', '10 kHz'] },
  7: { centers: [80, 250, 500, 1000, 2000, 4000, 10000], labels: ['80 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '10 kHz'] },
  10: { centers: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], labels: ['31 Hz', '62 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'] }
};

const SWEEP = {
  startHz: 30,
  endHz: 16000,
  durationSeconds: 12,
  autoSweepOffsets: [3.5, 17.5],
  manualSweepOffsets: [0, 14],
  autoEndSeconds: 40,
  manualEndSeconds: 36.5
};

const els = {
  start: document.querySelector('#startButton'), preset: document.querySelector('#eqPreset'), profile: document.querySelector('#profileName'),
  card: document.querySelector('.live-card'), dot: document.querySelector('#liveStatusDot'), status: document.querySelector('#liveStatusText'),
  title: document.querySelector('#live-title'), description: document.querySelector('#liveDescription'), meter: document.querySelector('#levelMeter'),
  level: document.querySelector('#levelText'), results: document.querySelector('#results'), recommendations: document.querySelector('#recommendations'),
  canvas: document.querySelector('#responseChart'), again: document.querySelector('#measureAgain'), save: document.querySelector('#saveResult'),
  export: document.querySelector('#exportResult'), toast: document.querySelector('#toast'), manual: document.querySelector('#manualStart')
};

let audioContext = null;
let stream = null;
let animationId = null;
let currentResult = null;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove('show'), 2400);
}
function setLive(status, title, description, active = false) {
  els.status.textContent = status;
  els.title.textContent = title;
  els.description.textContent = description;
  els.dot.classList.toggle('active', active);
  els.card.classList.toggle('listening', active);
}
function stopListening() {
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = null;
}
function rmsLevel(data) {
  let sumSquares = 0;
  for (let index = 0; index < data.length; index += 1) sumSquares += data[index] * data[index];
  const rms = Math.sqrt(sumSquares / data.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}
function rmsRange(samples, start, end) {
  const first = clamp(Math.floor(start), 0, samples.length);
  const last = clamp(Math.floor(end), first + 1, samples.length);
  let sumSquares = 0;
  for (let index = first; index < last; index += 1) sumSquares += samples[index] * samples[index];
  return Math.sqrt(sumSquares / Math.max(1, last - first));
}
function analyseSweeps(chunks, totalSamples, sampleRate, sweepStarts, preset) {
  const samples = new Float32Array(totalSamples);
  let writeAt = 0;
  chunks.forEach(chunk => { samples.set(chunk, writeAt); writeAt += chunk.length; });
  const ratio = SWEEP.endHz / SWEEP.startHz;
  const frequencyTime = frequency => Math.log(frequency / SWEEP.startHz) / Math.log(ratio) * SWEEP.durationSeconds;
  const absoluteLevels = preset.centers.map((center, index) => {
    const lower = Math.max(SWEEP.startHz, index === 0 ? center / Math.sqrt(preset.centers[1] / center) : Math.sqrt(preset.centers[index - 1] * center));
    const upper = Math.min(SWEEP.endHz, index === preset.centers.length - 1 ? center * Math.sqrt(center / preset.centers[index - 1]) : Math.sqrt(center * preset.centers[index + 1]));
    const startOffset = frequencyTime(lower), endOffset = frequencyTime(upper);
    const powers = sweepStarts.map(sweepStart => {
      const trim = Math.min(0.08, Math.max(0, (endOffset - startOffset) / 8));
      const rms = rmsRange(samples, sweepStart + (startOffset + trim) * sampleRate, sweepStart + (endOffset - trim) * sampleRate);
      return rms * rms;
    });
    const meanPower = powers.reduce((sum, power) => sum + power, 0) / powers.length;
    return 10 * Math.log10(Math.max(meanPower, 1e-12));
  });
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return { absoluteLevels, peakDbfs: peak ? 20 * Math.log10(peak) : -100 };
}
function formatAdjustment(value) {
  if (value === 0) return 'Leave';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} dB`;
}
function finishMeasurement(absoluteLevels, preset, peakDbfs) {
  stopListening();
  els.manual.hidden = true;
  const middle = median(absoluteLevels);
  const raw = absoluteLevels.map(value => value - middle);
  const smoothed = raw.map((value, index) => {
    const previous = raw[index - 1], next = raw[index + 1];
    return previous === undefined || next === undefined ? value : value * 0.6 + previous * 0.2 + next * 0.2;
  });
  const adjustments = smoothed.map(value => {
    if (value > 0.75) return Math.round(clamp(-value, -3, 0));
    if (value < -1.5 && value > -5) return Math.round(clamp(-value, 0, 2));
    return 0;
  });
  currentResult = {
    app: 'RoomTone TV EQ', version: 2, method: 'dual logarithmic sine sweep', measuredAt: new Date().toISOString(), profile: els.profile.value.trim() || 'My TV',
    preset: `${preset.centers.length}-band`, frequencies: preset.centers, labels: preset.labels,
    responseDb: smoothed.map(value => Math.round(value * 10) / 10), suggestedAdjustmentsDb: adjustments,
    peakDbfs: Math.round(peakDbfs * 10) / 10,
    note: 'Dual-sweep listening-position measurement made with a device microphone. Deep room nulls are not boosted.'
  };
  els.recommendations.replaceChildren(...preset.labels.map((label, index) => {
    const row = document.createElement('div'); row.className = 'rec-row';
    const name = document.createElement('span'); name.textContent = label;
    const value = document.createElement('strong'); value.textContent = formatAdjustment(adjustments[index]);
    value.className = adjustments[index] < 0 ? 'cut' : adjustments[index] === 0 ? 'flat' : '';
    row.append(name, value); return row;
  }));
  setLive('DUAL SWEEP COMPLETE', 'Response captured', 'The two sweeps were averaged. Review the conservative changes below, then measure again after applying them.');
  els.start.disabled = false;
  els.start.innerHTML = '<span class="button-icon" aria-hidden="true"></span> Start listening';
  els.meter.style.width = '0%'; els.level.textContent = 'Done'; els.results.hidden = false;
  requestAnimationFrame(() => { drawChart(currentResult); els.results.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
async function startMeasurement() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setLive('MICROPHONE UNAVAILABLE', 'This browser cannot listen', 'Open the page over HTTPS in a recent version of Safari, Chrome, Edge, or Firefox.'); return;
  }
  stopListening(); els.results.hidden = true; els.start.disabled = true; els.start.textContent = 'Requesting microphone…';
  setLive('REQUESTING ACCESS', 'Allow microphone access', 'Your audio is analysed live and is never uploaded or saved.', true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)(); await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream), analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.35; source.connect(analyser);
    const preset = PRESETS[els.preset.value], waveform = new Float32Array(analyser.fftSize), ambientReadings = [], recordedChunks = [];
    let recordedSamples = 0, phase = 'ambient', phaseStarted = performance.now(), loudSince = null, loudStartSample = null, referenceSample = null, captureEndSample = null, sweepStarts = null;
    const appendChunk = chunk => { recordedChunks.push(chunk); recordedSamples += chunk.length; };
    let recorder;
    const silentGain = audioContext.createGain(); silentGain.gain.value = 0; silentGain.connect(audioContext.destination);
    if (audioContext.audioWorklet && window.AudioWorkletNode) {
      await audioContext.audioWorklet.addModule('recorder-worklet.js?v=3');
      recorder = new AudioWorkletNode(audioContext, 'roomtone-recorder');
      recorder.port.onmessage = event => appendChunk(event.data);
      source.connect(recorder); recorder.connect(silentGain);
    } else {
      recorder = audioContext.createScriptProcessor(4096, 1, 1);
      recorder.onaudioprocess = event => appendChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(recorder); recorder.connect(silentGain);
    }
    els.start.textContent = 'Listening…';
    els.manual.hidden = false;
    els.manual.textContent = 'I hear the first sweep — start now';
    els.manual.onclick = () => {
      referenceSample = recordedSamples;
      sweepStarts = SWEEP.manualSweepOffsets.map(offset => referenceSample + offset * audioContext.sampleRate);
      captureEndSample = referenceSample + SWEEP.manualEndSeconds * audioContext.sampleRate;
      phase = 'measuring'; els.manual.hidden = true;
    };
    setLive('LISTENING FOR SYNC', 'Now play the new sweep track', 'RoomTone will lock onto the opening noise burst, then record two rising sweeps.', true);
    const tick = now => {
      analyser.getFloatTimeDomainData(waveform);
      const level = rmsLevel(waveform), meterPercent = clamp((level + 70) * 2, 2, 100);
      els.meter.style.width = `${meterPercent}%`; els.level.textContent = `${Math.round(level)} dB`;
      if (phase === 'ambient') {
        if (Number.isFinite(level)) ambientReadings.push(level);
        if (now - phaseStarted > 1400) { phase = 'waiting'; phaseStarted = now; }
      } else if (phase === 'waiting') {
        const ambient = ambientReadings.length ? median(ambientReadings) : -75;
        const threshold = Math.min(-28, Math.max(-65, ambient + 6));
        if (level > threshold) {
          if (loudSince === null) { loudSince = now; loudStartSample = recordedSamples; }
          if (now - loudSince > 650) {
            referenceSample = loudStartSample;
            sweepStarts = SWEEP.autoSweepOffsets.map(offset => referenceSample + offset * audioContext.sampleRate);
            captureEndSample = referenceSample + SWEEP.autoEndSeconds * audioContext.sampleRate;
            phase = 'measuring';
            els.manual.hidden = true;
            setLive('SYNC LOCKED', 'Hold still', 'The first logarithmic sweep will begin after the quiet gap.', true);
          }
        } else { loudSince = null; loudStartSample = null; }
        if (now - phaseStarted > 60000) {
          stopListening(); els.start.disabled = false; els.manual.hidden = true;
          els.start.innerHTML = '<span class="button-icon" aria-hidden="true"></span> Try again';
          setLive('TRACK NOT FOUND', 'We could not hear the track', 'Raise the TV volume slightly and restart the measurement.');
          return;
        }
      } else if (phase === 'measuring') {
        const elapsed = (recordedSamples - referenceSample) / audioContext.sampleRate;
        const autoAligned = sweepStarts[0] - referenceSample > audioContext.sampleRate;
        const firstStart = autoAligned ? SWEEP.autoSweepOffsets[0] : 0;
        const secondStart = autoAligned ? SWEEP.autoSweepOffsets[1] : SWEEP.manualSweepOffsets[1];
        if (elapsed < firstStart) els.status.textContent = 'SYNC LOCKED · QUIET GAP';
        else if (elapsed < firstStart + SWEEP.durationSeconds) els.status.textContent = 'MEASURING · SWEEP 1 OF 2';
        else if (elapsed < secondStart) els.status.textContent = 'MEASURING · QUIET GAP';
        else if (elapsed < secondStart + SWEEP.durationSeconds) els.status.textContent = 'MEASURING · SWEEP 2 OF 2';
        else els.status.textContent = 'VALIDATING RESPONSE';
        if (recordedSamples >= captureEndSample) {
          setLive('ANALYSING SWEEPS', 'Calculating response', 'Averaging both passes and translating them to your TV controls.', true);
          const analysis = analyseSweeps(recordedChunks, recordedSamples, audioContext.sampleRate, sweepStarts, preset);
          finishMeasurement(analysis.absoluteLevels, preset, analysis.peakDbfs); return;
        }
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
  } catch (error) {
    stopListening(); els.start.disabled = false; els.manual.hidden = true; els.start.innerHTML = '<span class="button-icon" aria-hidden="true"></span> Try again';
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError', timeout = error?.message === 'track-timeout';
    setLive(denied ? 'ACCESS BLOCKED' : timeout ? 'TRACK NOT FOUND' : 'MICROPHONE ERROR', denied ? 'Microphone permission is off' : timeout ? 'We could not hear the track' : 'We could not start the microphone', denied ? 'Enable microphone access for this site in your browser settings, then try again.' : timeout ? 'Raise the TV volume slightly and restart the measurement.' : 'Check that no other app is using the microphone and try again.');
  }
}
function drawChart(result) {
  const canvas = els.canvas, rect = canvas.getBoundingClientRect(); if (!rect.width) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(260 * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const width = rect.width, height = 260, margin = { top: 24, right: 18, bottom: 42, left: 38 }, innerWidth = width - margin.left - margin.right, innerHeight = height - margin.top - margin.bottom;
  const x = index => margin.left + (result.labels.length === 1 ? innerWidth / 2 : index * innerWidth / (result.labels.length - 1));
  const y = value => margin.top + ((8 - clamp(value, -8, 8)) / 16) * innerHeight;
  ctx.font = '11px Inter, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [-6, -3, 0, 3, 6].forEach(value => {
    ctx.strokeStyle = value === 0 ? '#597075' : '#1c3039'; ctx.setLineDash(value === 0 ? [5, 5] : []);
    ctx.beginPath(); ctx.moveTo(margin.left, y(value)); ctx.lineTo(width - margin.right, y(value)); ctx.stroke();
    ctx.fillStyle = '#597075'; ctx.fillText(`${value > 0 ? '+' : ''}${value}`, margin.left - 8, y(value));
  });
  ctx.setLineDash([]);
  const gradient = ctx.createLinearGradient(0, margin.top, 0, height - margin.bottom); gradient.addColorStop(0, 'rgba(78,225,184,.28)'); gradient.addColorStop(1, 'rgba(78,225,184,0)');
  ctx.beginPath(); result.responseDb.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
  ctx.lineTo(x(result.responseDb.length - 1), height - margin.bottom); ctx.lineTo(x(0), height - margin.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); result.responseDb.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
  ctx.strokeStyle = '#4ee1b8'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  result.responseDb.forEach((value, index) => { ctx.beginPath(); ctx.arc(x(index), y(value), 4, 0, Math.PI * 2); ctx.fillStyle = '#071119'; ctx.fill(); ctx.strokeStyle = '#4ee1b8'; ctx.lineWidth = 2; ctx.stroke(); });
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8fa6a7'; result.labels.forEach((label, index) => ctx.fillText(label, x(index), height - margin.bottom + 13));
}
function saveResult() {
  if (!currentResult) return;
  const saved = JSON.parse(localStorage.getItem('roomtone.measurements') || '[]'); saved.unshift(currentResult);
  localStorage.setItem('roomtone.measurements', JSON.stringify(saved.slice(0, 20))); showToast('Measurement saved on this device');
}
function exportResult() {
  if (!currentResult) return;
  const blob = new Blob([JSON.stringify(currentResult, null, 2)], { type: 'application/json' }), link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `roomtone-${currentResult.profile.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tv'}-${currentResult.measuredAt.slice(0, 10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
}
els.start.addEventListener('click', startMeasurement);
els.again.addEventListener('click', () => { els.results.hidden = true; window.scrollTo({ top: 0, behavior: 'smooth' }); window.setTimeout(startMeasurement, 450); });
els.save.addEventListener('click', saveResult); els.export.addEventListener('click', exportResult);
window.addEventListener('resize', () => currentResult && drawChart(currentResult)); window.addEventListener('beforeunload', stopListening);
