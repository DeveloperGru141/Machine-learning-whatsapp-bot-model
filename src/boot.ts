console.log(`[Boot] Entry process started with Node ${process.version} (pid ${process.pid}).`);

try {
  await import('./index.js');
} catch (error) {
  console.error('[Boot] Failed while loading the application module graph:', error);
  process.exitCode = 1;
}