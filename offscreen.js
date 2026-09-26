// Offscreen document: not subject to service-worker idle-kill. A message every 20s resets the SW idle timer
// so long model calls / pause_for_human do not drop agent state mid-task.
setInterval(() => { try { chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {}); } catch {} }, 20000);
