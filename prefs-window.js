// The Settings window: a normal, focusable window (the island itself never takes focus).
const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');

let win = null;

// page: open the window on that page (a news link, "Get plugin")
function open(page) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (page) send('show-page', page);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(760, area.width),
    height: Math.min(560, area.height),
    minWidth: Math.min(640, area.width),
    minHeight: Math.min(480, area.height),
    frame: false,
    show: false,
    backgroundColor: '#0f0f15',
    title: 'Nova Island Settings',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'prefs', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'prefs', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (page) send('show-page', page);
  });
  win.on('closed', () => { win = null; });
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

ipcMain.on('prefs-window', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w !== win) return;
  if (action === 'close') w.close();
  else if (action === 'minimize') w.minimize();
});

const owns = (contents) => !!win && !win.isDestroyed() && win.webContents === contents;
module.exports = { open, send, owns };
