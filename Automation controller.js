// Automation controller.js — RPA recording/replay + Schedule automation
// controllers for the TrafficDrive dashboard.
//
// Provides:
//   RPA:  rpaStart, rpaStopAndSave, rpaLoadFile, rpaRefreshSavedList,
//         rpaClearConsole, rpaPlay, rpaDelete
//   Schedule: scheduleTypeChanged, saveSchedule, toggleSchedule
//
// RPA recording opens a Playwright browser via the backend API and records
// user actions. Replay sends the recorded action list back to the backend
// which re-executes them. Saved recordings are stored in localStorage.

(function () {
  'use strict';

  // --- RPA state -----------------------------------------------------------
  let rpaActive = false;
  let rpaSessionName = '';
  let rpaStartTime = 0;
  let rpaDurationTimer = null;
  let rpaStats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0 };
  const scheduleState = { timer: null };

  function rpaLog(msg, type) {
    const consoleEl = document.getElementById('rpaConsole');
    if (!consoleEl) return;
    const tagMap = { info: 'INFO', success: 'SUCCESS', error: 'ERROR', warn: 'WARNING' };
    const tag = tagMap[type] || 'INFO';
    const cls = type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info';
    const now = new Date();
    const ts = '[' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0') + ']';
    const row = '<div class="lr"><span class="lts">' + ts + '</span><span class="ltag ' + cls + '">' + tag + '</span><span class="lmsg">' + (window.escapeHtml || String)(msg) + '</span></div>';
    consoleEl.insertAdjacentHTML('beforeend', row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function rpaUpdateStatus(status) {
    const badge = document.getElementById('rpa-status-badge');
    const icon = document.getElementById('rpa-status-icon');
    const label = document.getElementById('rpa-status-label');
    const startBtn = document.getElementById('rpaStartBtn');
    const stopBtn = document.getElementById('rpaStopBtn');
    const map = {
      idle: { text: 'Idle', icon: '⏹', color: 'var(--t3)' },
      recording: { text: 'Recording', icon: '🔴', color: 'var(--red)' },
      replaying: { text: 'Replaying', icon: '▶', color: 'var(--grn)' },
    };
    const s = map[status] || map.idle;
    if (badge) { badge.textContent = s.text; badge.style.background = s.color; }
    if (icon) icon.textContent = s.icon;
    if (label) label.textContent = s.text;
    if (startBtn) startBtn.disabled = (status === 'recording' || status === 'replaying');
    if (stopBtn) stopBtn.disabled = (status !== 'recording' && status !== 'replaying');
  }

  function rpaUpdateStats() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('rpa-stat-clicks', rpaStats.clicks);
    set('rpa-stat-inputs', rpaStats.inputs);
    set('rpa-stat-scrolls', rpaStats.scrolls);
    set('rpa-stat-keys', rpaStats.keys);
    set('rpa-stat-nav', rpaStats.nav);
    set('rpa-stat-other', rpaStats.other);
    const total = rpaStats.clicks + rpaStats.inputs + rpaStats.scrolls + rpaStats.keys + rpaStats.nav + rpaStats.other;
    set('rpa-action-count', total);
  }

  function rpaResetStats() {
    rpaStats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0 };
    rpaUpdateStats();
  }

  // --- RPA: Start recording ------------------------------------------------
  function rpaStart() {
    if (rpaActive) return;
    const url = (document.getElementById('rpaUrl') || {}).value || '';
    const speed = (document.getElementById('rpaReplaySpeed') || {}).value || '1';
    rpaActive = true;
    rpaSessionName = 'session_' + Date.now();
    rpaStartTime = Date.now();
    rpaResetStats();
    rpaUpdateStatus('recording');
    rpaLog('Starting RPA recording' + (url ? ' → ' + url : ' (blank page)'), 'info');
    const sessionEl = document.getElementById('rpa-session-name');
    if (sessionEl) sessionEl.textContent = rpaSessionName;
    // Duration timer
    if (rpaDurationTimer) clearInterval(rpaDurationTimer);
    rpaDurationTimer = setInterval(() => {
      const dur = ((Date.now() - rpaStartTime) / 1000).toFixed(1);
      const el = document.getElementById('rpa-duration');
      if (el) el.textContent = dur + 's';
    }, 100);
    // Tell backend to open a recording browser
    apiFetch('http://localhost:3000/api/rpa/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, speed }),
    }).then(r => r.json()).then(data => {
      if (data && data.success) {
        rpaLog('Recording browser opened.', 'success');
      } else {
        rpaLog('Backend RPA start returned: ' + ((data && data.error) || 'no response'), 'warn');
      }
    }).catch(err => {
      rpaLog('Backend RPA start failed: ' + err.message + ' (recording UI active anyway)', 'warn');
    });
  }

  // --- RPA: Stop & Save ----------------------------------------------------
  function rpaStopAndSave() {
    if (!rpaActive) return;
    rpaActive = false;
    if (rpaDurationTimer) { clearInterval(rpaDurationTimer); rpaDurationTimer = null; }
    const duration = ((Date.now() - rpaStartTime) / 1000).toFixed(1);
    rpaUpdateStatus('idle');
    rpaLog('Stopping recording. Duration: ' + duration + 's', 'info');
    apiFetch('http://localhost:3000/api/rpa/stop', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        const actions = (data && data.actions) || [];
        rpaStats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0 };
        actions.forEach((a) => {
          if (a.type === 'click') rpaStats.clicks++;
          else if (a.type === 'input') rpaStats.inputs++;
          else if (a.type === 'scroll') rpaStats.scrolls++;
          else if (a.type === 'key') rpaStats.keys++;
          else if (a.type === 'navigate') rpaStats.nav++;
          else rpaStats.other++;
        });
        rpaUpdateStats();
        const recording = {
          name: rpaSessionName,
          date: new Date().toISOString(),
          duration: parseFloat(duration),
          actions,
          stats: { ...rpaStats },
        };
        // Save to localStorage
        try {
          const list = JSON.parse(localStorage.getItem('rpa_recordings') || '[]');
          list.unshift(recording);
          localStorage.setItem('rpa_recordings', JSON.stringify(list));
        } catch (e) {}
        rpaLog('Recording saved: ' + actions.length + ' actions, ' + duration + 's', 'success');
        rpaRefreshSavedList();
      })
      .catch(err => {
        rpaLog('Backend stop failed: ' + err.message + ' (saved locally without actions)', 'warn');
        rpaRefreshSavedList();
      });
  }

  // --- RPA: Refresh saved recordings list ----------------------------------
  function rpaRefreshSavedList() {
    const listEl = document.getElementById('rpaSavedList');
    if (!listEl) return;
    let recordings = [];
    try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
    if (!recordings.length) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:20px">No recordings yet. Click Start RPA to begin.</div>';
      return;
    }
    let html = '';
    recordings.forEach((rec, idx) => {
      const actionCount = rec.actions ? rec.actions.length : 0;
      html += '<div class="rpa-rec-item" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--card2);border-radius:var(--r);margin-bottom:8px">' +
        '<div style="flex:1"><div style="font-weight:600;color:var(--t1)">' + (window.escapeHtml || String)(rec.name) + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + (window.escapeHtml || String)(rec.date || '') + ' · ' + actionCount + ' actions · ' + (rec.duration || 0) + 's</div></div>' +
        '<button class="btn btn-g" onclick="rpaPlay(' + idx + ')" style="padding:5px 10px;font-size:11px">▶ Play</button>' +
        '<button class="btn btn-danger" onclick="rpaDelete(' + idx + ')" style="padding:5px 10px;font-size:11px">Delete</button>' +
        '</div>';
    });
    listEl.innerHTML = html;
  }

  // --- RPA: Play a recording -----------------------------------------------
  function rpaPlay(idx) {
    let recordings = [];
    try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
    const rec = recordings[idx];
    if (!rec) return;
    rpaUpdateStatus('replaying');
    rpaLog('Replaying: ' + rec.name + ' (' + (rec.actions ? rec.actions.length : 0) + ' actions)', 'info');
    apiFetch('http://localhost:3000/api/rpa/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: rec.actions || [], speed: 1 }),
    }).then(r => r.json()).then(data => {
      rpaUpdateStatus('idle');
      if (data && data.success) {
        rpaLog('Replay complete.', 'success');
      } else {
        rpaLog('Replay finished: ' + ((data && data.error) || 'done'), 'info');
      }
    }).catch(err => {
      rpaUpdateStatus('idle');
      rpaLog('Replay failed: ' + err.message, 'error');
    });
  }

  // --- RPA: Delete a recording ---------------------------------------------
  function rpaDelete(idx) {
    let recordings = [];
    try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
    if (idx < 0 || idx >= recordings.length) return;
    recordings.splice(idx, 1);
    try { localStorage.setItem('rpa_recordings', JSON.stringify(recordings)); } catch (e) {}
    rpaRefreshSavedList();
    rpaLog('Recording deleted.', 'warn');
  }

  // --- RPA: Import file ----------------------------------------------------
  function rpaLoadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const rec = JSON.parse(ev.target.result);
          rec.name = rec.name || 'imported_' + Date.now();
          rec.date = rec.date || new Date().toISOString();
          const list = JSON.parse(localStorage.getItem('rpa_recordings') || '[]');
          list.unshift(rec);
          localStorage.setItem('rpa_recordings', JSON.stringify(list));
          rpaLog('Imported recording: ' + rec.name, 'success');
          rpaRefreshSavedList();
        } catch (err) {
          rpaLog('Import failed: invalid JSON file', 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // --- RPA: Clear console --------------------------------------------------
  function rpaClearConsole() {
    const el = document.getElementById('rpaConsole');
    if (el) el.innerHTML = '';
  }

  // --- Schedule automation -------------------------------------------------
  function scheduleTypeChanged() {
    const sel = document.getElementById('scheduleType');
    if (!sel) return;
    const type = sel.value;
    const delayFields = document.getElementById('scheduleDelayFields');
    const dtFields = document.getElementById('scheduleDatetimeFields');
    const recurFields = document.getElementById('scheduleRecurringFields');
    if (delayFields) delayFields.style.display = (type === 'delay') ? 'block' : 'none';
    if (dtFields) dtFields.style.display = (type === 'datetime') ? 'block' : 'none';
    if (recurFields) recurFields.style.display = (type === 'recurring') ? 'block' : 'none';
  }

  function saveSchedule() {
    const type = (document.getElementById('scheduleType') || {}).value || 'delay';
    const sched = { type, enabled: true, createdAt: Date.now() };
    if (type === 'delay') {
      sched.delayHours = parseInt((document.getElementById('schedDelayHours') || {}).value, 10) || 0;
      sched.delayMinutes = parseInt((document.getElementById('schedDelayMinutes') || {}).value, 10) || 0;
      sched.delaySeconds = parseInt((document.getElementById('schedDelaySeconds') || {}).value, 10) || 0;
    } else if (type === 'datetime') {
      const date = (document.getElementById('schedDate') || {}).value || '';
      const time = (document.getElementById('schedTime') || {}).value || '09:00';
      sched.datetime = date ? (date + 'T' + time) : '';
    } else if (type === 'recurring') {
      sched.days = Array.from(document.querySelectorAll('input[name="schedDay"]:checked')).map(cb => parseInt(cb.value, 10));
      sched.recurTime = (document.getElementById('schedRecurTime') || {}).value || '09:00';
    }
    // Campaign settings
    sched.trafficMode = (document.getElementById('schedTrafficMode') || {}).value || 'direct';
    sched.url = (document.getElementById('schedUrl') || {}).value || '';
    sched.sessions = parseInt((document.getElementById('schedSessions') || {}).value, 10) || 1;
    sched.threads = parseInt((document.getElementById('schedThreads') || {}).value, 10) || 1;
    sched.keyword = (document.getElementById('schedKeyword') || {}).value || '';
    sched.refPlatform = (document.getElementById('schedRefPlatform') || {}).value || 'random';
    sched.headless = document.getElementById('schedHeadlessToggle') ? document.getElementById('schedHeadlessToggle').classList.contains('on') : false;
    try { localStorage.setItem('trafficdrive_schedule', JSON.stringify(sched)); } catch (e) {}
    // Save to server
    apiFetch('http://localhost:3000/api/schedule/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sched),
    }).then(r => r.json()).then(data => {
      if (data.success) {
        const badge = document.getElementById('schedule-status-badge');
        if (badge) { badge.textContent = 'Scheduled'; badge.style.background = 'var(--grn)'; }
        if (typeof addLog === 'function') addLog('success', 'Schedule saved to server.');
        refreshSavedSchedules();
      }
    }).catch(err => {
      if (typeof addLog === 'function') addLog('warn', 'Schedule saved locally (server unreachable).');
    });
    const badge = document.getElementById('schedule-status-badge');
    if (badge) { badge.textContent = 'Scheduled'; badge.style.background = 'var(--grn)'; }
    if (typeof addLog === 'function') addLog('success', 'Schedule saved.');
  }

  function toggleSchedule() {
    let sched = {};
    try { sched = JSON.parse(localStorage.getItem('trafficdrive_schedule') || '{}'); } catch (e) {}
    sched.enabled = !sched.enabled;
    try { localStorage.setItem('trafficdrive_schedule', JSON.stringify(sched)); } catch (e) {}
    apiFetch('http://localhost:3000/api/schedule/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: sched.enabled }),
    }).catch(() => {});
    const badge = document.getElementById('schedule-status-badge');
    if (badge) {
      badge.textContent = sched.enabled ? 'Scheduled' : 'No Schedule';
      badge.style.background = sched.enabled ? 'var(--grn)' : 'var(--t3)';
    }
  }

  // setTimeout() overflows above ~24.8 days (and then fires immediately), so
  // long waits are chained in hops. scheduleState.timer is always the live hop.
  const MAX_TIMEOUT_MS = 2147483647;
  function setLongTimeout(fn, ms) {
    if (ms > MAX_TIMEOUT_MS) {
      scheduleState.timer = setTimeout(() => setLongTimeout(fn, ms - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
    } else {
      scheduleState.timer = setTimeout(fn, Math.max(0, ms));
    }
  }

  function setScheduleButtons(active) {
    const activateBtn = document.getElementById('schedActivateBtn');
    const cancelBtn = document.getElementById('schedCancelBtn');
    if (activateBtn) activateBtn.disabled = !!active;
    if (cancelBtn) cancelBtn.disabled = !active;
    const countdownEl = document.getElementById('schedCountdown');
    if (countdownEl) countdownEl.style.display = active ? 'block' : 'none';
  }

  // Next timestamp matching one of `days` (0=Sun … 6=Sat) at "HH:MM".
  function nextRecurringRun(days, timeStr, from) {
    const parts = String(timeStr || '09:00').split(':');
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(hh, mm, 0, 0);
      if (days.indexOf(d.getDay()) !== -1 && d.getTime() > from) return d.getTime();
    }
    return null;
  }

  // Recurring weekly schedules used to fall through to "run immediately" once.
  function armRecurring(sched) {
    const days = Array.isArray(sched.days) ? sched.days.map(Number) : [];
    const next = nextRecurringRun(days, sched.recurTime, Date.now());
    if (!next) {
      if (typeof addLog === 'function') addLog('warn', 'Recurring schedule has no days selected.');
      setScheduleButtons(false);
      return;
    }
    const wait = next - Date.now();
    if (typeof addLog === 'function') addLog('info', 'Next scheduled run: ' + new Date(next).toLocaleString());
    startCountdown(wait);
    setLongTimeout(() => {
      runScheduledCampaign(sched);
      armRecurring(sched); // then wait for the following occurrence
    }, wait);
  }

  // --- Schedule: Activate (save + enable + start timer) ---
  function scheduleActivate() {
    saveSchedule();
    if (scheduleState.timer) { clearTimeout(scheduleState.timer); scheduleState.timer = null; }
    setScheduleButtons(true);
    let sched = {};
    try { sched = JSON.parse(localStorage.getItem('trafficdrive_schedule') || '{}'); } catch (e) {}
    if (!sched.enabled) { setScheduleButtons(false); return; }

    const runOnce = () => {
      scheduleState.timer = null;
      runScheduledCampaign(sched);
      setScheduleButtons(false);
    };
    const delayMs = ((sched.delayHours || 0) * 3600 + (sched.delayMinutes || 0) * 60 + (sched.delaySeconds || 0)) * 1000;
    if (sched.type === 'delay' && delayMs > 0) {
      if (typeof addLog === 'function') addLog('info', 'Schedule will run in ' + (sched.delayHours || 0) + 'h ' + (sched.delayMinutes || 0) + 'm ' + (sched.delaySeconds || 0) + 's');
      startCountdown(delayMs);
      setLongTimeout(runOnce, delayMs);
    } else if (sched.type === 'datetime' && sched.datetime) {
      const wait = new Date(sched.datetime).getTime() - Date.now();
      if (wait > 0) {
        if (typeof addLog === 'function') addLog('info', 'Schedule will run at ' + sched.datetime);
        startCountdown(wait);
        setLongTimeout(runOnce, wait);
      } else {
        if (typeof addLog === 'function') addLog('warn', 'Scheduled time has already passed.');
        setScheduleButtons(false); // previously left "Activate" disabled
      }
    } else if (sched.type === 'recurring') {
      armRecurring(sched);
    } else {
      // Run immediately
      if (typeof addLog === 'function') addLog('info', 'Running scheduled campaign now...');
      runOnce();
    }
  }

  // Countdown timer
  let countdownInterval = null;
  function startCountdown(ms) {
    if (countdownInterval) clearInterval(countdownInterval);
    const end = Date.now() + ms;
    countdownInterval = setInterval(() => {
      const remaining = end - Date.now();
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        const el = document.getElementById('schedCountdown');
        if (el) el.style.display = 'none';
        return;
      }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      const hEl = document.getElementById('schedCdHours');
      const mEl = document.getElementById('schedCdMinutes');
      const sEl = document.getElementById('schedCdSeconds');
      if (hEl) hEl.textContent = String(h).padStart(2, '0');
      if (mEl) mEl.textContent = String(m).padStart(2, '0');
      if (sEl) sEl.textContent = String(s).padStart(2, '0');
    }, 1000);
  }

  // --- Schedule: Cancel ---
  // Stops the active timer only. (It used to call /api/schedule/delete with no
  // id, which wiped every saved schedule.)
  function scheduleCancel() {
    if (scheduleState.timer) { clearTimeout(scheduleState.timer); scheduleState.timer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    try { localStorage.removeItem('trafficdrive_schedule'); } catch (e) {}
    const badge = document.getElementById('schedule-status-badge');
    if (badge) { badge.textContent = 'No Schedule'; badge.style.background = 'var(--t3)'; }
    setScheduleButtons(false);
    if (typeof addLog === 'function') addLog('warn', 'Schedule cancelled.');
  }

  // --- Run scheduled campaign ---
  // Fills the dashboard form from the schedule and presses Start. (It used to
  // call setMode()/startCampaign() and write #targetUrl — none of which exist —
  // so nothing ever started.)
  const SCHED_MODES = ['direct', 'organic', 'referral', 'gmaps', 'rpa'];
  function runScheduledCampaign(sched) {
    const mode = SCHED_MODES.indexOf(sched.trafficMode) !== -1 ? sched.trafficMode : 'direct';
    if (typeof addLog === 'function') addLog('success', 'Running scheduled campaign: ' + mode);

    if (mode === 'rpa') {
      let recordings = [];
      try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
      if (!recordings.length) {
        if (typeof addLog === 'function') addLog('warn', 'Scheduled RPA replay skipped: no saved recordings.');
        return;
      }
      if (typeof addLog === 'function') addLog('info', 'Replaying most recent recording: ' + recordings[0].name);
      rpaPlay(0);
      return;
    }

    if (typeof isRunning !== 'undefined' && isRunning) {
      if (typeof addLog === 'function') addLog('warn', 'Scheduled run skipped: a campaign is already running.');
      return;
    }

    const modeEl = document.querySelector('.mi[onclick*="\'' + mode + '\'"]');
    if (modeEl && typeof selMode === 'function') selMode(modeEl, mode);

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el && v !== undefined && v !== null && v !== '') el.value = v;
    };
    if (mode === 'gmaps') {
      // The schedule form has no business-name field; its Keyword is used.
      setVal('bizName', sched.keyword);
      setVal('bizUrl', sched.url);
    } else {
      setVal('websiteUrl', sched.url);
      if (mode === 'organic') setVal('keywords', sched.keyword);
    }
    setVal('numSessions', sched.sessions);
    setVal('numThreads', sched.threads);
    if (mode === 'referral') setVal('refPlatform', sched.refPlatform);
    if (typeof selHeadlessMode === 'function') selHeadlessMode(sched.headless ? 'headless' : 'visible');

    if (typeof startCamp === 'function') {
      startCamp();
    } else if (typeof addLog === 'function') {
      addLog('error', 'Could not start the scheduled campaign (dashboard not ready).');
    }
  }

  // --- Refresh saved schedules list ---
  function refreshSavedSchedules() {
    const listEl = document.getElementById('schedSavedList');
    if (!listEl) return;
    apiFetch('http://localhost:3000/api/schedule/list')
      .then(r => r.json())
      .then(data => {
        if (!data.success || !data.savedSchedules || data.savedSchedules.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:16px">No schedules saved yet. Configure and click Activate Schedule.</div>';
          return;
        }
        const modeNames = { direct: 'Direct Traffic', organic: 'Organic Traffic', referral: 'Referral Traffic', gmaps: 'Google Maps', rpa: 'RPA Replay' };
        let html = '';
        data.savedSchedules.forEach((sched) => {
          const date = new Date(sched.savedAt || sched.createdAt).toLocaleString();
          const modeLabel = modeNames[sched.trafficMode] || sched.trafficMode || 'Direct';
          const typeLabel = sched.type === 'delay' ? 'After Delay' : sched.type === 'datetime' ? 'Date & Time' : 'Recurring';
          const delayLabel = sched.type === 'delay' ? ((sched.delayHours || 0) + 'h ' + (sched.delayMinutes || 0) + 'm ' + (sched.delaySeconds || 0) + 's') : (sched.datetime || sched.recurTime || '');
          const safeId = String(sched.id || '').replace(/[^\w-]/g, '');
          html += '<div class="rpa-rec-item" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--card2);border-radius:var(--r);margin-bottom:8px">' +
            '<div style="flex:1"><div style="font-weight:600;color:var(--t1)">' + (window.escapeHtml || String)(modeLabel) + ' → ' + (window.escapeHtml || String)((sched.url || 'No URL').substring(0, 40)) + '</div>' +
            '<div style="font-size:11px;color:var(--t3)">' + date + ' · ' + typeLabel + ' · ' + (window.escapeHtml || String)(delayLabel) + ' · ' + (sched.sessions || 1) + ' sessions · ' + (sched.threads || 1) + ' threads' + (sched.enabled ? '' : ' · DISABLED') + '</div></div>' +
            '<button class="btn btn-g" onclick="activateSavedSchedule(\'' + safeId + '\')" style="padding:5px 10px;font-size:11px">▶ Run</button>' +
            '<button class="btn btn-danger" onclick="deleteSavedSchedule(\'' + safeId + '\')" style="padding:5px 10px;font-size:11px">Delete</button>' +
            '</div>';
        });
        listEl.innerHTML = html;
      })
      .catch(() => {
        listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:16px">No schedules saved yet. Configure and click Activate Schedule.</div>';
      });
  }

  // --- Activate a saved schedule ---
  function activateSavedSchedule(id) {
    apiFetch('http://localhost:3000/api/schedule/list')
      .then(r => r.json())
      .then(data => {
        const sched = data.savedSchedules.find(s => s.id === id);
        if (!sched) return;
        if (typeof addLog === 'function') addLog('info', 'Activating saved schedule: ' + (sched.trafficMode || 'direct'));
        runScheduledCampaign(sched);
      })
      .catch(() => {});
  }

  // --- Delete a saved schedule ---
  function deleteSavedSchedule(id) {
    apiFetch('http://localhost:3000/api/schedule/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(r => r.json()).then(data => {
      if (data.success) {
        if (typeof addLog === 'function') addLog('warn', 'Schedule deleted.');
        refreshSavedSchedules();
      }
    }).catch(() => {});
  }

  // --- Schedule console clear ---
  function schedClearConsole() {
    const el = document.getElementById('schedConsole');
    if (el) el.innerHTML = '';
  }

  // --- Expose globally -----------------------------------------------------
  window.rpaStart = rpaStart;
  window.rpaStopAndSave = rpaStopAndSave;
  window.rpaLoadFile = rpaLoadFile;
  window.rpaRefreshSavedList = rpaRefreshSavedList;
  window.rpaClearConsole = rpaClearConsole;
  window.rpaPlay = rpaPlay;
  window.rpaDelete = rpaDelete;
  window.scheduleTypeChanged = scheduleTypeChanged;
  window.saveSchedule = saveSchedule;
  window.toggleSchedule = toggleSchedule;
  window.scheduleActivate = scheduleActivate;
  window.scheduleCancel = scheduleCancel;
  window.runScheduledCampaign = runScheduledCampaign;
  window.refreshSavedSchedules = refreshSavedSchedules;
  window.activateSavedSchedule = activateSavedSchedule;
  window.deleteSavedSchedule = deleteSavedSchedule;
  window.schedClearConsole = schedClearConsole;

  // Refresh saved list on load
  document.addEventListener('DOMContentLoaded', () => {
    rpaRefreshSavedList();
    refreshSavedSchedules();
  });
})();
