const path = require('path')
const fs = require('fs')
const { compile } = require('mvc-scrypt')

const contractDir = path.resolve(__dirname, '../src/synthesis/contracts')
const descDir = path.resolve(__dirname, '../src/synthesis/contract-desc')
const isDebug = process.argv.includes('--debug')

if (!fs.existsSync(descDir)) {
  fs.mkdirSync(descDir, { recursive: true })
}

const files = fs.readdirSync(contractDir).filter((f) => f.endsWith('.scrypt'))

for (const file of files) {
  const src = path.join(contractDir, file)
  console.log(`compiling ${file} ...`)
  const result = compile(
    { path: src },
    { desc: true, debug: isDebug, sourceMap: isDebug, outputDir: descDir }
  )
  if (result.errors.length > 0) {
    console.error(`Compile ${file} failed:`, result.errors)
    process.exitCode = 1
  } else {
    console.log(`compiled ${file} ok`)
  }
}
