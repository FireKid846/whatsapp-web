// server.js - Deploy this to Render as Background Worker
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  delay,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { createClient } from '@supabase/supabase-js';
import { Octokit } from "@octokit/rest";
import http from 'http';

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const logger = pino({ level: "silent" });
const activeSockets = new Map();
const processingQueue = new Set();

console.log('🚀 Starting WhatsApp Session Monitor...');
console.log(`📊 Supabase: ${SUPABASE_URL ? 'Connected' : 'NOT SET'}`);
console.log(`📦 GitHub: ${GITHUB_REPO_URL || 'NOT SET'}`);

// GitHub upload function
async function uploadToGitHub(sessionId, phoneNumber, sessionPath) {
  if (!GITHUB_TOKEN || !GITHUB_REPO_URL) {
    console.log('⚠️  GitHub not configured, skipping upload');
    return null;
  }

  try {
    const match = GITHUB_REPO_URL.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) throw new Error('Invalid GitHub URL');
    
    const [, owner, repo] = match;
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    
    const sessionFolder = `sessions/${sessionId}`;
    const files = fs.readdirSync(sessionPath);
    
    for (const file of files) {
      const filePath = path.join(sessionPath, file);
      if (fs.lstatSync(filePath).isDirectory()) continue;
      
      const content = fs.readFileSync(filePath).toString('base64');
      
      const { data: existing } = await octokit.repos
        .getContent({ owner, repo, path: `${sessionFolder}/${file}` })
        .catch(() => ({ data: null }));
      
      await octokit.repos.createOrUpdateFileContents({
        owner, repo,
        path: `${sessionFolder}/${file}`,
        message: `Update ${sessionId}`,
        content,
        sha: existing?.sha,
      });
      
      await delay(300);
    }
    
    const githubUrl = `https://github.com/${owner}/${repo}/tree/main/${sessionFolder}`;
    console.log(`✅ GitHub upload: ${githubUrl}`);
    return githubUrl;
  } catch (error) {
    console.error('GitHub upload error:', error.message);
    return null;
  }
}

// Send welcome messages
async function sendWelcomeMessages(socket, phoneNumber, sessionId) {
  try {
    const images = [
      'https://ik.imagekit.io/firekid/photo_2025-09-08_14-11-15.jpg',
      'https://ik.imagekit.io/firekid/photo_2025-09-08_13-31-44.jpg',
      'https://ik.imagekit.io/firekid/photo_2025-09-08_13-34-15.jpg'
    ];
    
    const randomImage = images[Math.floor(Math.random() * images.length)];
    const jid = `${phoneNumber}@s.whatsapp.net`;

    const welcomeMessage =
      `🔥 *Firekid Bot - Connected*\n\n` +
      `Your WhatsApp is now paired successfully!\n\n` +
      `*Features:*\n` +
      `• Automated replies\n` +
      `• Smart notifications\n` +
      `• Advanced tools\n\n` +
      `_Built by Firekid_`;

    await delay(3000);
    await socket.sendMessage(jid, {
      image: { url: randomImage },
      caption: welcomeMessage,
    });

    await delay(2000);
    await socket.sendMessage(jid, {
      text: `📋 *Session ID:* \`${sessionId}\``
    });

    console.log(`✅ Welcome messages sent to ${phoneNumber}`);
  } catch (error) {
    console.error('Welcome message error:', error.message);
  }
}

// Monitor a single session
async function monitorSession(session) {
  const sessionId = session.id;
  
  // Skip if already processing
  if (processingQueue.has(sessionId) || activeSockets.has(sessionId)) {
    return;
  }
  
  processingQueue.add(sessionId);
  console.log(`\n📌 Processing session: ${sessionId}`);
  console.log(`   Phone: ${session.phone_number}`);
  console.log(`   Status: ${session.status}`);
  
  const sessionPath = path.join("/tmp", "sessions", sessionId);
  
  try {
    // Create session directory
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Using WA v${version.join(".")}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const socket = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.macOS("Chrome"),
      connectTimeoutMs: 180000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    socket.ev.on("creds.update", saveCreds);

    // Store active socket
    activeSockets.set(sessionId, {
      socket,
      phoneNumber: session.phone_number,
      sessionPath,
      timestamp: Date.now()
    });
    
    processingQueue.delete(sessionId);

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      console.log(`📡 [${sessionId}] ${connection || 'update'}`);

      // Connection opened - SUCCESS!
      if (connection === "open") {
        console.log(`✅ [${sessionId}] CONNECTED!`);
        
        try {
          // Update Supabase
          await supabase
            .from('sessions')
            .update({
              status: 'connected',
              connected_at: new Date().toISOString(),
              last_activity: new Date().toISOString()
            })
            .eq('id', sessionId);

          // Log event
          await supabase
            .from('session_logs')
            .insert({
              session_id: sessionId,
              log_level: 'info',
              message: 'Session connected successfully'
            });

          // Send welcome messages
          await sendWelcomeMessages(socket, session.phone_number, sessionId);

          // Upload to GitHub
          const githubUrl = await uploadToGitHub(sessionId, session.phone_number, sessionPath);
          
          if (githubUrl) {
            await supabase
              .from('sessions')
              .update({
                github_url: githubUrl,
                saved_to_github: true
              })
              .eq('id', sessionId);
          }

          console.log(`🎉 [${sessionId}] Setup complete!`);
        } catch (error) {
          console.error(`Error handling connection:`, error.message);
        }
      }

      // Connection closed
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ [${sessionId}] Closed: ${statusCode}`);

        // Handle 515 restart (reconnect needed)
        if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          console.log(`🔄 [${sessionId}] Restart required, will retry...`);
          activeSockets.delete(sessionId);
          processingQueue.delete(sessionId);
          
          // Let next poll pick it up
          return;
        }

        // Logged out
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`🚪 [${sessionId}] Logged out`);
          
          await supabase
            .from('sessions')
            .update({ status: 'disconnected' })
            .eq('id', sessionId);
          
          activeSockets.delete(sessionId);
          processingQueue.delete(sessionId);
          return;
        }

        // Other disconnections
        console.log(`⚠️  [${sessionId}] Unexpected close`);
        activeSockets.delete(sessionId);
        processingQueue.delete(sessionId);
      }
    });

  } catch (error) {
    console.error(`❌ [${sessionId}] Error:`, error.message);
    
    await supabase
      .from('session_logs')
      .insert({
        session_id: sessionId,
        log_level: 'error',
        message: `Monitor error: ${error.message}`
      });
    
    activeSockets.delete(sessionId);
    processingQueue.delete(sessionId);
  }
}

// Poll Supabase for waiting sessions
async function pollWaitingSessions() {
  try {
    const { data: waitingSessions, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('status', 'waiting')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Poll error:', error.message);
      return;
    }

    if (!waitingSessions || waitingSessions.length === 0) {
      return;
    }

    console.log(`\n🔍 Found ${waitingSessions.length} waiting session(s)`);

    for (const session of waitingSessions) {
      await monitorSession(session);
      await delay(1000); // Small delay between sessions
    }
  } catch (error) {
    console.error('❌ Poll error:', error.message);
  }
}

// Cleanup stale sessions
async function cleanupStaleSessions() {
  const now = Date.now();
  const staleTimeout = 5 * 60 * 1000; // 5 minutes

  for (const [sessionId, data] of activeSockets.entries()) {
    if (now - data.timestamp > staleTimeout) {
      console.log(`🧹 Cleaning stale socket: ${sessionId}`);
      
      try {
        data.socket.ev.removeAllListeners();
        data.socket.end();
      } catch (e) {}
      
      if (fs.existsSync(data.sessionPath)) {
        fs.rmSync(data.sessionPath, { recursive: true, force: true });
      }
      
      activeSockets.delete(sessionId);
    }
  }
}

// Health check server (required for Render)
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      activeSessions: activeSockets.size,
      processingQueue: processingQueue.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Health server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

// Start polling immediately
console.log('\n🔄 Starting session monitor...\n');
pollWaitingSessions();

// Poll every 10 seconds
setInterval(pollWaitingSessions, 10000);

// Cleanup every 3 minutes
setInterval(cleanupStaleSessions, 3 * 60 * 1000);

// Status update every minute
setInterval(() => {
  console.log(`\n💓 Status Update:`);
  console.log(`   Active Sockets: ${activeSockets.size}`);
  console.log(`   Processing Queue: ${processingQueue.size}`);
  console.log(`   Uptime: ${Math.floor(process.uptime() / 60)} minutes\n`);
}, 60000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n⚠️  SIGTERM received, shutting down gracefully...');
  
  for (const [sessionId, data] of activeSockets.entries()) {
    try {
      data.socket.ev.removeAllListeners();
      data.socket.end();
      console.log(`🔌 Closed socket: ${sessionId}`);
    } catch (e) {}
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

console.log('\n✅ WhatsApp Session Monitor initialized!\n');
