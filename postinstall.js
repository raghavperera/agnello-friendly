// postinstall.js (ESM)
import { generateDependencyReport } from '@discordjs/voice';

console.log('=======================================================');
console.log('@discordjs/voice dependency report — useful for debugging voice/encryption issues');
console.log('=======================================================');
try {
  const report = generateDependencyReport();
  console.log(report);
} catch (err) {
  console.error('Failed to generate dependency report:', err);
}
