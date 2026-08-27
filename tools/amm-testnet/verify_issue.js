// 逐输入用 Script.Interpreter 验证 issue-main.hex
const fs = require('fs')
const path = require('path')
const { mvc } = require('../../dist/index')
const { getRawTx } = require('./lib')

const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'amm-state.json'), 'utf8'))
const mainHex = fs.readFileSync(path.join(__dirname, 'issue-main.hex'), 'utf8').trim()
const ucHex = fs.readFileSync(path.join(__dirname, 'issue-unlockcheck.hex'), 'utf8').trim()
const A1 = 'msREe5jsynP65899v1KJCydf6Sc9pJPb8S'

const tx = new mvc.Transaction(mainHex)
const ucTx = new mvc.Transaction(ucHex)

async function main() {
  // prev scripts
  const prevScripts = []
  // input0: PoolGenesis
  prevScripts.push(mvc.Script.fromBuffer(Buffer.from(state.deploy.genesisScript, 'hex')))
  // inputs1-3: locked FT outputs from preLock main txs
  for (const key of ['A', 'B', 'LP']) {
    const preRaw = await getRawTx(state.locked[key].txid)
    if (!preRaw) throw new Error(`no raw ${state.locked[key].txid}`)
    const preTx = new mvc.Transaction(preRaw)
    prevScripts.push(preTx.outputs[0].script)
  }
  // inputs4-6: amountCheck outputs
  for (let i = 0; i < 3; i++) prevScripts.push(ucTx.outputs[i].script)
  // input7: fee P2PKH
  prevScripts.push(mvc.Script.buildPublicKeyHashOut(new mvc.Address(A1, 'testnet')))

  const satoshisByInput = []
  for (let i = 0; i < tx.inputs.length; i++) {
    if (i === 7) satoshisByInput.push(ucTx.outputs[ucTx.outputs.length - 1].satoshis)
    else satoshisByInput.push(1)
  }

  console.log('inputs', tx.inputs.length)
  let anyFail = false
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]
    const interpreter = new mvc.Script.Interpreter()
    const flags =
      mvc.Script.Interpreter.SCRIPT_VERIFY_P2SH |
      mvc.Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID |
      mvc.Script.Interpreter.SCRIPT_ENABLE_REPLAY_PROTECTION |
      mvc.Script.Interpreter.SCRIPT_ENABLE_MONOLITH_OPCODES |
      mvc.Script.Interpreter.SCRIPT_ENABLE_MAGNETIC_OPCODES
    let ok = false
    let err = ''
    try {
      ok = interpreter.verify(input.script, prevScripts[i], tx, i, flags, satoshisByInput[i])
      err = interpreter.errstr || ''
    } catch (e) {
      err = e.message
    }
    console.log(`input ${i}:`, ok ? 'PASS' : `FAIL ${err}`)
    if (!ok) anyFail = true
  }
  if (!anyFail) console.log('ALL PASS')
}

main().catch((e) => {
  console.error('FAILED', e.stack || e.message)
  process.exit(1)
})
