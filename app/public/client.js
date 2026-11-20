/**
 * Entry point. The whole game runs client-side; see js/main.js for the loop
 * and js/net.js for the (optional) link to the room that records mission
 * progress and the final score.
 */
import { boot } from './js/main.js';

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('boot');
  if (el) el.textContent = 'Failed to start: ' + (err && err.message ? err.message : err);
});
