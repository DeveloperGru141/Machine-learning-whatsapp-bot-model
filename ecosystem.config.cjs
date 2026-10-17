module.exports = {
  apps: [
    {
      name: 'forgelabs-whatsapp-bot',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork', // MUST be fork (single instance) to prevent duplicate WhatsApp 440 socket conflicts
      autorestart: true,
      watch: false,
      max_memory_restart: '550M',
      restart_delay: 3000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
