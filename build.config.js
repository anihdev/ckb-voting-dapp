const esbuild = require('esbuild');
  const { execSync } = require('child_process');
  
  async function build() {
    // Bundle TypeScript
    await esbuild.build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      outfile: 'dist/voting-script.js',
      platform: 'node',
      target: 'es2020',
      format: 'cjs'
    });
    
    // Compile to RISC-V bytecode
    execSync('ckb-js-vm compile dist/voting-script.js -o dist/voting-script.bc');
    
    console.log('Build complete!');
  }
  
  build().catch(console.error);