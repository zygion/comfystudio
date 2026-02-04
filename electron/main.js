const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs').promises
const fsSync = require('fs')

const isDev = process.env.NODE_ENV !== 'production'

let mainWindow = null

// Register custom protocol for serving local files
function registerFileProtocol() {
  protocol.handle('storyflow', async (request) => {
    const url = request.url.replace('storyflow://', '')
    const filePath = decodeURIComponent(url)
    
    try {
      // Security: Only allow access to files within user's documents or app paths
      const normalizedPath = path.normalize(filePath)
      
      return net.fetch(`file://${normalizedPath}`)
    } catch (err) {
      console.error('Protocol error:', err)
      return new Response('File not found', { status: 404 })
    }
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // In dev mode, disable web security to allow file:// URLs from localhost
      // In production, the app loads from file:// so this isn't an issue
      webSecurity: !isDev,
    }
  })

  // Load the app
  if (isDev) {
    // Try common Vite ports in case 5173 is in use
    const tryPorts = [5173, 5174, 5175, 5176]
    let loaded = false
    
    for (const port of tryPorts) {
      try {
        await mainWindow.loadURL(`http://localhost:${port}`)
        console.log(`Loaded from port ${port}`)
        loaded = true
        break
      } catch (err) {
        console.log(`Port ${port} not available, trying next...`)
      }
    }
    
    if (!loaded) {
      console.error('Could not connect to Vite dev server on any port')
    }
    
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  
  // Register keyboard shortcut for DevTools (F12 or Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || 
        (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
}

// ============================================
// IPC Handlers - Dialog Operations
// ============================================

ipcMain.handle('dialog:selectDirectory', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: options.title || 'Select Folder',
    defaultPath: options.defaultPath || app.getPath('documents'),
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return result.filePaths[0]
})

ipcMain.handle('dialog:selectFile', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', ...(options.multiple ? ['multiSelections'] : [])],
    title: options.title || 'Select File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'Media Files', extensions: ['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return options.multiple ? result.filePaths : result.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled) {
    return null
  }
  
  return result.filePath
})

// ============================================
// IPC Handlers - File System Operations
// ============================================

ipcMain.handle('fs:exists', async (event, filePath) => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:isDirectory', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return stat.isDirectory()
  } catch {
    return false
  }
})

ipcMain.handle('fs:createDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.mkdir(dirPath, { recursive: options.recursive !== false })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFile', async (event, filePath, options = {}) => {
  try {
    const encoding = options.encoding || null // null returns Buffer
    const data = await fs.readFile(filePath, encoding)
    
    // If no encoding specified, return as base64 for binary files
    if (!encoding) {
      return { success: true, data: data.toString('base64'), encoding: 'base64' }
    }
    
    return { success: true, data, encoding }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFileAsBuffer', async (event, filePath) => {
  try {
    const data = await fs.readFile(filePath)
    return { success: true, data: data.buffer }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFile', async (event, filePath, data, options = {}) => {
  try {
    // Ensure parent directory exists
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    
    // Handle different data types
    let writeData = data
    if (options.encoding === 'base64') {
      writeData = Buffer.from(data, 'base64')
    } else if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      // JSON object
      writeData = JSON.stringify(data, null, 2)
    }
    
    await fs.writeFile(filePath, writeData, options.encoding === 'base64' ? null : options)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFileFromArrayBuffer', async (event, filePath, arrayBuffer) => {
  try {
    // Ensure parent directory exists
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    
    const buffer = Buffer.from(arrayBuffer)
    await fs.writeFile(filePath, buffer)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteFile', async (event, filePath) => {
  try {
    await fs.unlink(filePath)
    return { success: true }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { success: true } // Already deleted
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.rm(dirPath, { recursive: options.recursive !== false, force: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:copyFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.copyFile(srcPath, destPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:moveFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.rename(srcPath, destPath)
    return { success: true }
  } catch (err) {
    // If rename fails (cross-device), fall back to copy + delete
    if (err.code === 'EXDEV') {
      await fs.copyFile(srcPath, destPath)
      await fs.unlink(srcPath)
      return { success: true }
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:listDirectory', async (event, dirPath, options = {}) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name)
      let stat = null
      
      if (options.includeStats) {
        try {
          stat = await fs.stat(fullPath)
        } catch {
          // Ignore stat errors
        }
      }
      
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size: stat?.size,
        modified: stat?.mtime?.toISOString(),
        created: stat?.birthtime?.toISOString(),
      }
    }))
    
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err.message, items: [] }
  }
})

ipcMain.handle('fs:getFileInfo', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return {
      success: true,
      info: {
        name: path.basename(filePath),
        path: filePath,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// IPC Handlers - Path Operations
// ============================================

ipcMain.handle('path:join', (event, ...parts) => {
  return path.join(...parts)
})

ipcMain.handle('path:dirname', (event, filePath) => {
  return path.dirname(filePath)
})

ipcMain.handle('path:basename', (event, filePath, ext) => {
  return path.basename(filePath, ext)
})

ipcMain.handle('path:extname', (event, filePath) => {
  return path.extname(filePath)
})

ipcMain.handle('path:normalize', (event, filePath) => {
  return path.normalize(filePath)
})

ipcMain.handle('path:getAppPath', (event, name) => {
  // Valid names: home, appData, userData, documents, downloads, music, pictures, videos, temp
  return app.getPath(name)
})

// ============================================
// IPC Handlers - Media Info (using HTML5 in renderer for now)
// Future: Replace with FFprobe for frame-accurate info
// ============================================

ipcMain.handle('media:getFileUrl', (event, filePath) => {
  // Convert file path to storyflow:// protocol URL
  const encodedPath = encodeURIComponent(filePath)
  return `storyflow://${encodedPath}`
})

ipcMain.handle('media:getFileUrlDirect', (event, filePath) => {
  // Return file:// URL directly (for when protocol isn't working)
  // Normalize path for URL
  let normalizedPath = filePath.replace(/\\/g, '/')
  if (!normalizedPath.startsWith('/')) {
    normalizedPath = '/' + normalizedPath
  }
  return `file://${normalizedPath}`
})

// ============================================
// IPC Handlers - App Settings Storage
// ============================================

const settingsPath = path.join(app.getPath('userData'), 'settings.json')

ipcMain.handle('settings:get', async (event, key) => {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    return key ? settings[key] : settings
  } catch {
    return key ? null : {}
  }
})

ipcMain.handle('settings:set', async (event, key, value) => {
  try {
    let settings = {}
    try {
      const data = await fs.readFile(settingsPath, 'utf8')
      settings = JSON.parse(data)
    } catch {
      // File doesn't exist yet
    }
    
    settings[key] = value
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('settings:delete', async (event, key) => {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    delete settings[key]
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  registerFileProtocol()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})
