const PRESETS = {
  3: { centers: [125, 1000, 8000], labels: ['Bass', 'Mid', 'Treble'] },
  5: { centers: [100, 300, 1000, 3000, 10000], labels: ['100 Hz', '300 Hz', '1 kHz', '3 kHz', '10 kHz'] },
  7: { centers: [80, 250, 500, 1000, 2000, 4000, 10000], labels: ['80 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '10 kHz'] },
  10: { centers: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], labels: ['31 Hz', '62 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'] }
};

const els = {
  start: document.querySelector('#startButton'), preset: document.querySelector('#eqPreset'), profile: document.querySelector('#profileName'),
  card: document.querySelector('.live-card'), dot: document.querySelector('#liveStatusDot'), status: document.querySelector('#liveStatusText'),
  title: document.querySelector('#live-title'), description: document.querySelector('#liveDescription'), meter: document.querySelector('#levelMeter'),
  level: document.querySelector('#levelText'), results: document.querySelector('#results'), recommendations: document.querySelector('#recommendations'),
  canvas: document.querySelector('#responseChart'), again: document.querySelector('#measureAgain'), save: document.querySelector('#saveResult'),
  export: document.querySelector('#exportResult'), toast: document.querySelector('#toast')
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
function overallLevel(data, sampleRate) {
  const binHz = sampleRate / (data.length * 2);
  let power = 0, count = 0;
  for (let i = 1; i < data.length; i += 1) {
    const frequency = i * binHz;
    if (frequency >= 120 && frequency <= 12000 && Number.isFinite(data[i])) {
      power += 10 ** (data[i] / 10); count += 1;
    }
  }
  return count ? 10 * Math.log10(power / count) : -100;
}
function bandLevels(data, sampleRate, centers) {
  const binHz = sampleRate / (data.length * 2);
  return centers.map((center, index) => {
    const lower = index === 0 ? center / Math.sqrt(centers[1] / center) : Math.sqrt(centers[index - 1] * center);
    const upper = index === centers.length - 1 ? center * Math.sqrt(center / centers[index - 1]) : Math.sqrt(center * centers[index + 1]);
    let weightedPower = 0, count = 0;
    for (let i = Math.max(1, Math.ceil(lower / binHz)); i < Math.min(data.length, Math.floor(upper / binHz)); i += 1) {
      if (Number.isFinite(data[i])) {
        weightedPower += (10 ** (data[i] / 10)) * (i * binHz); count += 1;
      }
    }
    return count ? 10 * Math.log10(weightedPower / count) : -100;
  });
}
function formatAdjustment(value) {
  if (value === 0) return 'Leave';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} dB`;
}
function finishMeasurement(sums, frameCount, preset) {
  stopListening();
  const absoluteLevels = sums.map(sum => 10 * Math.log10(sum / frameCount));
  const middle = median(absoluteLevels);
  const raw = absoluteLevels.map(value => value - middle);
  const smoothed = raw.map((value, index) => {
    const previous = raw[index - 1], next = raw[index + 1];
    return previous === undefined || next === undefined ? value : value * 0.6 + previous * 0.2 + next * 0.2;
  });
  const adjustments = smoothed.map(value => {
    const proposed = Math.round(clamp(-value, -6, 6));
    return Math.abs(proposed) < 1 ? 0 : proposed;
  });
  currentResult = {
    app: 'RoomTone TV EQ', version: 1, measuredAt: new Date().toISOString(), profile: els.profile.value.trim() || 'My TV',
    preset: `${preset.centers.length}-band`, frequencies: preset.centers, labels: preset.labels,
    responseDb: smoothed.map(value => Math.round(value * 10) / 10), suggestedAdjustmentsDb: adjustments,
    note: 'Approximate listening-position measurement made with a device microphone.'
  };
  els.recommendations.replaceChildren(...preset.labels.map((label, index) => {
    const row = document.createElement('div'); row.className = 'rec-row';
    const name = document.createElement('span'); name.textContent = label;
    const value = document.createElement('strong'); value.textContent = formatAdjustment(adjustments[index]);
    value.className = adjustments[index] < 0 ? 'cut' : adjustments[index] === 0 ? 'flat' : '';
    row.append(name, value); return row;
  }));
  setLive('MEASUREMENT COMPLETE', 'Response captured', 'Review the suggested changes below, apply them on the TV, then measure again.');
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
    analyser.fftSize = 8192; analyser.minDecibels = -110; analyser.maxDecibels = -10; analyser.smoothingTimeConstant = 0.45; source.connect(analyser);
    const preset = PRESETS[els.preset.value], spectrum = new Float32Array(analyser.frequencyBinCount), ambientReadings = [];
    const sums = preset.centers.map(() => 0); let frameCount = 0, phase = 'ambient', phaseStarted = performance.now(), loudSince = null, measurementStarted = null;
    const measurementDuration = 18000;
    els.start.textContent = 'Listening…';
    setLive('LISTENING FOR TRACK', 'Now play the test track', 'Keep this device still. Measurement begins when the pink noise is detected.', true);
    const tick = now => {
      analyser.getFloatFrequencyData(spectrum);
      const level = overallLevel(spectrum, audioContext.sampleRate), meterPercent = clamp((level + 75) * 1.7, 2, 100);
      els.meter.style.width = `${meterPercent}%`; els.level.textContent = `${Math.round(level)} dB`;
      if (phase === 'ambient') {
        if (Number.isFinite(level)) ambientReadings.push(level);
        if (now - phaseStarted > 1400) { phase = 'waiting'; phaseStarted = now; }
      } else if (phase === 'waiting') {
        const ambient = ambientReadings.length ? median(ambientReadings) : -75, threshold = Math.max(-72, ambient + 8);
        if (level > threshold) {
          loudSince ??= now;
          if (now - loudSince > 1200) {
            phase = 'measuring'; measurementStarted = now;
            setLive('MEASURING · 18 SECONDS', 'Hold still', 'Keep the room quiet while RoomTone maps the frequency response.', true);
          }
        } else loudSince = null;
        if (now - phaseStarted > 60000) {
          stopListening(); els.start.disabled = false;
          els.start.innerHTML = '<span class="button-icon" aria-hidden="true"></span> Try again';
          setLive('TRACK NOT FOUND', 'We could not hear the track', 'Raise the TV volume slightly and restart the measurement.');
          return;
        }
      } else if (phase === 'measuring') {
        const levels = bandLevels(spectrum, audioContext.sampleRate, preset.centers);
        levels.forEach((value, index) => { sums[index] += 10 ** (value / 10); }); frameCount += 1;
        const remaining = Math.max(0, Math.ceil((measurementDuration - (now - measurementStarted)) / 1000));
        els.status.textContent = `MEASURING · ${remaining} SECOND${remaining === 1 ? '' : 'S'}`;
        if (now - measurementStarted >= measurementDuration) { finishMeasurement(sums, Math.max(1, frameCount), preset); return; }
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
  } catch (error) {
    stopListening(); els.start.disabled = false; els.start.innerHTML = '<span class="button-icon" aria-hidden="true"></span> Try again';
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
