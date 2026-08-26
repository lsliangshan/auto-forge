/* global module, require */

const { createHash } = require('node:crypto')

const EMBEDDING_MODEL = 'kinfra-text-embedding-0.6b'
const EMBEDDING_DIMENSIONS = 1024
const RRF_CONSTANT = 60
const EXACT_COSINE_MAX_CHUNKS = 10000
const EMBEDDING_DRIFT_PROBE = 'autoforge:knowledge:embedding-drift-probe:v1'
const EMBEDDING_CONFIGURATION = Object.freeze({
  version: 1,
  dimensions: EMBEDDING_DIMENSIONS,
  fusion: 'rrf',
  rrfConstant: RRF_CONSTANT,
  vectorSearch: 'exact_cosine',
  exactCosineMaxChunks: EXACT_COSINE_MAX_CHUNKS,
})

function validEmbedding(vector) {
  return Array.isArray(vector)
    && vector.length === EMBEDDING_DIMENSIONS
    && vector.every(value => typeof value === 'number' && Number.isFinite(value))
}

function requireEmbedding(vector) {
  if (!validEmbedding(vector)) throw new Error('INVALID_EMBEDDING_DIMENSIONS')
  return vector
}

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function compareChunkIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactCosineRank(queryEmbedding, rows, limit) {
  requireEmbedding(queryEmbedding)
  if (!Array.isArray(rows) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('INVALID_INPUT')
  }
  return rows.map((row) => ({
    candidate: row.candidate,
    vectorScore: cosine(queryEmbedding, requireEmbedding(row.embedding)),
  })).sort((left, right) => (
    right.vectorScore - left.vectorScore
    || compareChunkIds(left.candidate.chunkId, right.candidate.chunkId)
  )).slice(0, limit)
}

function reciprocalRankFusion(keywordCandidates, vectorCandidates, limit) {
  if (!Array.isArray(keywordCandidates) || !Array.isArray(vectorCandidates)
    || !Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_INPUT')
  const fused = new Map()
  const add = (candidate, rank) => {
    if (!candidate || typeof candidate.chunkId !== 'string') throw new Error('INVALID_INPUT')
    const existing = fused.get(candidate.chunkId)
    const score = 1 / (RRF_CONSTANT + rank)
    if (existing) {
      existing.score += score
      existing.bestRank = Math.min(existing.bestRank, rank)
      return
    }
    fused.set(candidate.chunkId, { candidate, score, bestRank: rank })
  }
  keywordCandidates.forEach((candidate, index) => add(candidate, index + 1))
  vectorCandidates.forEach((candidate, index) => add(candidate, index + 1))
  return [...fused.values()].sort((left, right) => (
    right.score - left.score
    || left.bestRank - right.bestRank
    || compareChunkIds(left.candidate.chunkId, right.candidate.chunkId)
  )).slice(0, limit).map(({ candidate, score }) => ({
    ...candidate,
    evidence: { ...candidate.evidence, score },
  }))
}

function embeddingFingerprint(vector) {
  requireEmbedding(vector)
  const normalized = vector.map(value => Number(value.toFixed(8)))
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
}

module.exports = {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_CONFIGURATION,
  EMBEDDING_DRIFT_PROBE,
  EMBEDDING_MODEL,
  EXACT_COSINE_MAX_CHUNKS,
  RRF_CONSTANT,
  embeddingFingerprint,
  exactCosineRank,
  reciprocalRankFusion,
  validEmbedding,
}
