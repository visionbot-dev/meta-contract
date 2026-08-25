import * as mvc from '../mvc'

export const MERKLE_DEPTH = 4
export const MERKLE_LEAVES = 1 << MERKLE_DEPTH // 16
export const EMPTY_HASH = Buffer.alloc(20, 0)

function hash160(buf: Buffer): Buffer {
  return Buffer.from(mvc.crypto.Hash.sha256ripemd160(buf))
}

/**
 * Builds a 4-level Merkle tree from up to 16 recipe hashes (20B each).
 * Returns the root hash (20B hex) and a map of leafIndex -> proof.
 * Proof format: [sibling(20B) + isRight(1B)] * 4
 */
export function buildRecipeMerkleTree(recipeHashes: string[]): {
  root: string
  proofs: Map<number, Buffer>
} {
  let leaves: Buffer[] = recipeHashes.slice(0, MERKLE_LEAVES).map((h) => {
    const buf = Buffer.from(h, 'hex')
    if (buf.length !== 20) throw new Error('recipe hash must be 20 bytes')
    return buf
  })

  while (leaves.length < MERKLE_LEAVES) {
    leaves.push(EMPTY_HASH)
  }

  // levels[0] = leaves, levels[depth] = root
  const levels: Buffer[][] = [leaves]
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const current = levels[level]
    const next: Buffer[] = []
    for (let i = 0; i < current.length; i += 2) {
      next.push(hash160(Buffer.concat([current[i], current[i + 1]])))
    }
    levels.push(next)
  }

  const root = levels[MERKLE_DEPTH][0]
  const proofs = new Map<number, Buffer>()

  for (let leafIndex = 0; leafIndex < MERKLE_LEAVES; leafIndex++) {
    let proof = Buffer.alloc(0)
    let idx = leafIndex
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1
      const sibling = levels[level][siblingIndex]
      const isRight = idx % 2 === 0 ? Buffer.from([0]) : Buffer.from([1])
      proof = Buffer.concat([proof, sibling, isRight])
      idx = Math.floor(idx / 2)
    }
    proofs.set(leafIndex, proof)
  }

  return {
    root: root.toString('hex'),
    proofs,
  }
}
