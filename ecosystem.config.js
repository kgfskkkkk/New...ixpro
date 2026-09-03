// PM2 config — bot-a 24/7 background-la run panna.
// Start:   pm2 start ecosystem.config.js
// Status:  pm2 status
// Stop:    pm2 stop ishanxmd
// Restart: pm2 restart ishanxmd
// Logs:    pm2 logs ishanxmd
module.exports = {
  apps: [
    {
      name: 'ishanxmd',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,          // crash aanaalum automatic-aa restart aagum
      watch: false,
      max_memory_restart: '2G',  // 19 sessions nu RAM kasigam aagum, 2GB-a thaandi pona restart (was 500M → endless restart loop)
      kill_timeout: 5000,
      restart_delay: 3000,        // 3 sec wait pannitu restart
      max_restarts: 20,           // repeated crash-a thanniyum limit
      min_uptime: '10s',          // quick restart loop-a avoid pannum
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
