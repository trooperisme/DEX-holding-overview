/* The dialog observes server jobs. Closing it never changes the job lifecycle. */
window.createFullScanDialog = ({ onViewSnapshot }) => {
  const steps = ['Prepare portfolios', 'Fetch holdings', 'Enrich token data', 'Save snapshot'];
  let job = null;
  let starting = false;
  let error = '';
  let elapsedTimer = null;
  const button = document.getElementById('refresh-button');
  button.setAttribute('aria-haspopup', 'dialog');
  const status = document.createElement('section');
  status.className = 'scan-status';
  status.hidden = true;
  status.setAttribute('aria-label', 'Full scan status');
  status.innerHTML = '<div><span class="scan-dot" aria-hidden="true"></span><strong class="scan-status-title"></strong><span class="scan-status-copy"></span></div><button type="button">View progress ↗</button>';
  document.querySelector('.hero-panel').after(status);
  const dialog = document.createElement('dialog');
  dialog.className = 'scan-dialog';
  dialog.id = 'scan-dialog';
  dialog.setAttribute('aria-labelledby', 'scan-title');
  dialog.setAttribute('aria-describedby', 'scan-description');
  dialog.innerHTML = `
    <header class="scan-dialog-header"><span class="scan-kicker">DEX HOLDINGS <span> / </span> FULL SCAN</span><button type="button" class="scan-close" aria-label="Close scan progress" autofocus>×</button></header>
    <div class="scan-illustration"><img src="/dashboard/assets/scan-waiting.gif" alt="Waiting illustration" width="480" height="262"></div>
    <div class="scan-dialog-body">
      <p class="scan-eyebrow" id="scan-phase">PREPARING</p><h2 id="scan-title">Good things take a little time.</h2>
      <p id="scan-description">You can close this window and browse earlier snapshots. The scan continues in the background.</p>
      <div class="scan-progress-heading"><strong id="scan-current">Preparing portfolios…</strong><strong id="scan-percent"></strong></div>
      <div class="scan-progress" role="progressbar" aria-label="Entities processed" aria-valuemin="0" aria-valuemax="100"><div id="scan-progress-fill"></div></div>
      <div class="scan-metrics"><span id="scan-count"></span><span id="scan-elapsed"></span></div>
      <ol class="scan-steps">${steps.map((name, index) => `<li data-scan-step="${index}"><span>${index + 1}</span>${name}<small>Waiting</small></li>`).join('')}</ol>
      <div class="scan-live-note" role="status" aria-live="polite"></div>
      <a class="scan-worker" href="#" target="_blank" rel="noopener noreferrer" hidden>Open worker details ↗</a>
      <button type="button" class="scan-view-snapshot" hidden>View new snapshot ↗</button>
      <button type="button" class="scan-browse">Browse previous snapshots <span aria-hidden="true">↗</span></button>
      <p class="scan-footnote">Closing this window keeps the scan running. Full Scan opens it again.</p>
    </div>`;
  document.body.append(dialog);
  const get = id => document.getElementById(id);
  const elapsed = () => {
    const end = job?.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const seconds = Math.max(0, Math.floor((end - Date.parse(job?.startedAt || new Date().toISOString())) / 1000));
    get('scan-elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
  };
  function render(nextJob, options = {}) {
    job = nextJob;
    starting = Boolean(options.starting);
    error = options.error || '';
    const effective = starting && !job?.running ? null : job;
    const p = effective?.progress;
    const running = Boolean(effective?.running || starting);
    const state = p?.status || (error ? 'failed' : 'idle');
    const usable = !error && !running && ['success', 'partial'].includes(state) && Number(p?.snapshotId) > 0;
    const total = Number(p?.totalEntities || 0);
    const completed = Number(p?.entitiesCompleted || 0);
    const failed = Number(p?.entitiesFailed || 0);
    const processed = completed + failed;
    const percent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
    const phaseName = effective?.phase || (!total ? 'preparing' : /^Enriching|^Finalizing|^Saving/.test(p?.currentEntity || '') || processed >= total ? 'finalizing' : 'fetching');
    const phase = !running ? usable ? 4 : total ? 1 : 0 : phaseName === 'queued' || phaseName === 'preparing' ? 0 : phaseName === 'finalizing' ? 2 : 1;
    status.hidden = !effective && !starting && !error;
    status.dataset.state = running ? 'running' : ['success', 'partial'].includes(state) ? 'done' : 'failed';
    status.querySelector('.scan-status-title').textContent = error ? 'Progress connection interrupted' : running ? phaseName === 'queued' ? 'Scan queued' : 'Full scan running' : state === 'success' ? 'New snapshot ready' : state === 'partial' ? 'Snapshot ready with partial results' : `Scan ${state}`;
    status.querySelector('.scan-status-copy').textContent = running ? (total ? `${processed}/${total} entities processed · ${failed} failed` : 'Waiting for the background worker.') : usable ? `Snapshot #${p.snapshotId} is ready. Your current view is unchanged.` : error || p?.errorMessage || '';
    status.querySelector('button').textContent = running ? 'View progress ↗' : 'View summary ↗';
    button.disabled = false;
    button.setAttribute('aria-busy', String(starting));
    button.textContent = running ? total && phase === 1 ? `Full Scan · ${percent}%` : 'Full Scan · running' : 'Full Scan';
    get('scan-phase').textContent = error ? 'CONNECTION NOTICE' : phaseName === 'queued' && running ? 'QUEUED' : running ? `STEP ${phase + 1} OF 4` : state.toUpperCase();
    get('scan-title').textContent = error ? 'Checking on your scan.' : running ? 'Good things take a little time.' : state === 'success' ? 'Your new snapshot is ready.' : state === 'partial' ? 'Ready, with a few gaps.' : state === 'canceled' ? 'The scan was canceled.' : state === 'failed' ? 'The scan couldn’t finish.' : 'Preparing your scan.';
    get('scan-description').textContent = error ? `${error} We’ll keep trying to reconnect. Closing this window does not stop the worker.` : running ? 'You can close this window and browse earlier snapshots. The scan continues in the background.' : usable ? 'Open the new snapshot whenever you’re ready. You can keep reading the snapshot you already selected.' : p?.errorMessage || 'Checking whether a scan is already running before starting a new one.';
    get('scan-current').textContent = error ? 'Reconnecting…' : starting && !effective ? 'Checking scan status…' : p?.currentEntity || (running ? total ? 'Fetching tracked portfolios' : 'Preparing portfolios…' : usable ? `Snapshot #${p.snapshotId}` : 'Scan stopped');
    get('scan-percent').textContent = phase === 1 && total ? `${percent}%` : usable ? '100%' : running ? '…' : '';
    const progress = dialog.querySelector('[role="progressbar"]');
    const indeterminate = running && phase !== 1;
    progress.classList.toggle('is-indeterminate', indeterminate);
    if (indeterminate) progress.removeAttribute('aria-valuenow'); else progress.setAttribute('aria-valuenow', String(usable ? 100 : percent));
    get('scan-progress-fill').style.width = `${indeterminate ? 40 : usable ? 100 : percent}%`;
    get('scan-count').textContent = total ? `${processed}/${total} entities · ${failed} failed · ${Number(p?.totalRows || 0).toLocaleString()} holdings` : 'Waiting for worker progress';
    dialog.querySelectorAll('[data-scan-step]').forEach((element, index) => {
      const stepState = index < phase ? 'complete' : running && index === phase ? 'active' : 'pending';
      element.dataset.state = stepState;
      element.querySelector('span').textContent = stepState === 'complete' ? '✓' : String(index + 1);
      element.querySelector('small').textContent = stepState === 'complete' ? 'Done' : stepState === 'active' ? 'In progress' : 'Waiting';
      if (stepState === 'active') element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current');
    });
    const note = dialog.querySelector('.scan-live-note');
    const message = error || (running ? 'Scheduled runs stay enabled. Closing this window does not cancel the scan.' : state === 'partial' ? `${failed} entities could not be fetched. The available results are saved.` : usable ? 'Snapshot saved. Scheduled runs are unchanged.' : p?.errorMessage || '');
    if (note.textContent !== message) note.textContent = message;
    const workerLink = dialog.querySelector('.scan-worker');
    const safeWorkerUrl = /^https:\/\/github\.com\/trooperisme\/DEX-holding-overview\/actions\/runs\/\d+$/.test(effective?.workerUrl || '');
    workerLink.hidden = !safeWorkerUrl;
    if (safeWorkerUrl) workerLink.href = effective.workerUrl;
    dialog.querySelector('.scan-view-snapshot').hidden = !usable;
    dialog.querySelector('.scan-browse').firstChild.textContent = running ? 'Browse previous snapshots ' : 'Back to snapshots ';
    if (running && !elapsedTimer) elapsedTimer = setInterval(elapsed, 1000);
    if (!running && elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    elapsed();
  }
  function open() { if (!dialog.open) dialog.showModal(); }
  status.querySelector('button').addEventListener('click', open);
  dialog.querySelector('.scan-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.scan-browse').addEventListener('click', () => dialog.close());
  dialog.querySelector('.scan-view-snapshot').addEventListener('click', async event => {
    const target = event.currentTarget;
    target.disabled = true;
    try { await onViewSnapshot(job.progress.snapshotId); dialog.close(); }
    catch (error) { dialog.querySelector('.scan-live-note').textContent = error.message; }
    finally { target.disabled = false; }
  });
  dialog.addEventListener('close', () => button.focus());
  return { render, open, close: () => dialog.close() };
};
