// =============================================================================
// src/api/client.js
// Unified API client facade for Performance Analytics.
// The UI components ONLY call functions from this file — never the mock or
// normalizer files directly.
//
// Switches automatically between mock & live based on DATA_SOURCE in config.js.
// =============================================================================

import { getApiConfig } from './config.js'

// Mock modules
import { fetchFacebookPageInsights, fetchFacebookPostInsights } from './mock/facebook.js'
import { fetchInstagramAccountInsights, fetchInstagramMediaInsights } from './mock/instagram.js'
import { fetchLinkedinFollowerStatistics, fetchLinkedinShareStatistics } from './mock/linkedin.js'
import { fetchXUserMetrics, fetchXTweetMetrics } from './mock/x.js'
import { fetchSubstackPublicationStats, fetchSubstackPostStats } from './mock/substack.js'

// Normalizer modules
import { normalizeFacebookPageInsights } from './normalize/normalizeFacebook.js'
import { normalizeInstagramAccountInsights } from './normalize/normalizeInstagram.js'
import { normalizeLinkedinStatistics } from './normalize/normalizeLinkedin.js'
import { normalizeXUserMetrics } from './normalize/normalizeX.js'
import { normalizeSubstackPublication } from './normalize/normalizeSubstack.js'

// Fallback mock post dataset for top posts listing
import { PLATFORM_POSTS, ENGAGEMENT_RATES, getSortValue } from '../performanceData.js'

// ─── Internal error generator for testing triggerable mock scenarios ─────────
function checkMockScenario() {
  const { mockScenario } = getApiConfig()
  if (!mockScenario) return null

  if (mockScenario === 'auth_expired') {
    throw new Error('OAuth authentication token expired. Please re-connect your account in Profile.')
  }
  if (mockScenario === 'rate_limit') {
    throw new Error('API Rate Limit Exceeded. (HTTP 429 Too Many Requests)')
  }
  if (mockScenario === 'empty') {
    return []
  }
  return null
}

// ─── API Capabilities ────────────────────────────────────────────────────────

/**
 * Get account-level metrics for a specific platform & period.
 */
export async function getAccountMetrics(platformId, period = '30d', options = {}) {
  const scenarioResult = checkMockScenario()
  if (scenarioResult !== null) return scenarioResult

  const { dataSource } = getApiConfig()

  if (dataSource === 'live') {
    // Future live API fetch hook point
    throw new Error(`Live API wiring for ${platformId} not configured yet. Set VITE_DATA_SOURCE=mock.`)
  }

  // --- MOCK BRANCH ---
  switch (platformId) {
    case 'facebook': {
      const raw = await fetchFacebookPageInsights(period)
      return normalizeFacebookPageInsights(raw, period)
    }
    case 'instagram': {
      const raw = await fetchInstagramAccountInsights(period, options)
      return normalizeInstagramAccountInsights(raw, period)
    }
    case 'linkedin': {
      const followerRaw = await fetchLinkedinFollowerStatistics(period)
      const shareRaw = await fetchLinkedinShareStatistics(period)
      return normalizeLinkedinStatistics(followerRaw, shareRaw, period)
    }
    case 'x': {
      const raw = await fetchXUserMetrics()
      return normalizeXUserMetrics(raw, period)
    }
    case 'substack': {
      const raw = await fetchSubstackPublicationStats(period)
      return normalizeSubstackPublication(raw, period)
    }
    default:
      return []
  }
}

/**
 * Get detail metrics for a specific post.
 */
export async function getPostMetrics(platformId, postId) {
  const scenarioResult = checkMockScenario()
  if (scenarioResult !== null) return null

  const { dataSource } = getApiConfig()

  if (dataSource === 'live') {
    throw new Error(`Live post API for ${platformId} not configured yet.`)
  }

  // Find post in stable mock post registry
  const platformList = PLATFORM_POSTS[platformId] || []
  const post = platformList.find((p) => p.id === postId) || platformList[0]
  return post || null
}

/**
 * Get top posts for a channel & period, sorted by platform-relevant metric.
 */
export async function getTopPosts(channel = 'all', period = '30d', rankKey = null) {
  const scenarioResult = checkMockScenario()
  if (scenarioResult !== null) return []

  const days = parseInt(period, 10) || 30
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffIso = cutoff.toISOString().slice(0, 10)

  let source = []
  if (channel === 'all') {
    Object.values(PLATFORM_POSTS).forEach((list) => {
      source.push(...list)
    })
  } else {
    source = PLATFORM_POSTS[channel] || []
  }

  const filtered = source.filter((p) => p.publishedAt >= cutoffIso)

  if (rankKey) {
    filtered.sort((a, b) => getSortValue(b, rankKey) - getSortValue(a, rankKey))
  }

  return filtered
}

/**
 * Get cross-platform engagement rates.
 */
export async function getEngagementRates() {
  return ENGAGEMENT_RATES
}

/**
 * Get Best Time to Post Heatmap data for a channel.
 * Enforces data volume gate (requires >= 60-90 days of history).
 */
export async function getHeatmapData(platformId = 'facebook', period = '30d') {
  const scenarioResult = checkMockScenario()
  if (scenarioResult !== null) return { hasEnoughData: false, minDaysRequired: 60 }

  const days = parseInt(period, 10) || 30
  if (days < 60) {
    return {
      hasEnoughData: false,
      minDaysRequired: 60,
      currentDays: days,
      reason: 'Requires 60+ days of post history to calculate peak times accurately.',
    }
  }

  // Channel peak profile multipliers: [Mon..Sun] x [6am, 9am, 12pm, 3pm, 6pm, 9pm]
  const channelProfiles = {
    linkedin: [
      [0.2, 0.6, 0.8, 0.5, 0.3, 0.1], // Mon
      [0.3, 0.9, 0.95, 0.7, 0.4, 0.1], // Tue (Peak)
      [0.3, 1.0, 0.9, 0.8, 0.4, 0.1], // Wed (Peak)
      [0.3, 0.9, 0.85, 0.7, 0.4, 0.1], // Thu (Peak)
      [0.2, 0.5, 0.6, 0.4, 0.2, 0.1], // Fri
      [0.1, 0.2, 0.2, 0.1, 0.1, 0.1], // Sat
      [0.1, 0.1, 0.2, 0.2, 0.2, 0.1], // Sun
    ],
    instagram: [
      [0.2, 0.4, 0.6, 0.7, 0.9, 0.8], // Mon
      [0.2, 0.4, 0.5, 0.6, 0.8, 0.7], // Tue
      [0.3, 0.5, 0.7, 0.8, 0.95, 0.9], // Wed (Peak)
      [0.2, 0.4, 0.6, 0.7, 0.8, 0.8], // Thu
      [0.3, 0.5, 0.7, 0.8, 1.0, 0.95], // Fri (Peak)
      [0.2, 0.3, 0.5, 0.6, 0.8, 0.7], // Sat
      [0.2, 0.4, 0.6, 0.7, 0.9, 0.85], // Sun
    ],
    facebook: [
      [0.3, 0.5, 0.7, 0.6, 0.5, 0.4], // Mon
      [0.3, 0.6, 0.8, 0.7, 0.6, 0.4], // Tue
      [0.4, 0.7, 0.95, 0.8, 0.6, 0.4], // Wed (Peak)
      [0.4, 0.7, 0.9, 0.85, 0.7, 0.5], // Thu (Peak)
      [0.4, 0.8, 1.0, 0.9, 0.7, 0.5], // Fri (Peak)
      [0.2, 0.4, 0.6, 0.5, 0.5, 0.3], // Sat
      [0.2, 0.4, 0.5, 0.5, 0.4, 0.3], // Sun
    ],
    x: [
      [0.4, 0.8, 0.9, 0.7, 0.6, 0.5], // Mon
      [0.5, 0.95, 1.0, 0.8, 0.6, 0.5], // Tue (Peak)
      [0.5, 0.9, 0.95, 0.8, 0.7, 0.5], // Wed (Peak)
      [0.4, 0.8, 0.9, 0.7, 0.6, 0.5], // Thu
      [0.4, 0.7, 0.8, 0.6, 0.5, 0.4], // Fri
      [0.2, 0.3, 0.4, 0.4, 0.3, 0.2], // Sat
      [0.2, 0.3, 0.4, 0.4, 0.3, 0.3], // Sun
    ],
    substack: [
      [0.2, 0.7, 0.5, 0.3, 0.2, 0.1], // Mon
      [0.3, 1.0, 0.6, 0.4, 0.2, 0.1], // Tue (Peak)
      [0.2, 0.6, 0.5, 0.3, 0.2, 0.1], // Wed
      [0.3, 0.9, 0.6, 0.4, 0.2, 0.1], // Thu (Peak)
      [0.2, 0.5, 0.4, 0.3, 0.2, 0.1], // Fri
      [0.1, 0.3, 0.3, 0.2, 0.1, 0.1], // Sat
      [0.2, 0.6, 0.5, 0.3, 0.2, 0.1], // Sun
    ],
  }

  const profile = channelProfiles[platformId] || channelProfiles.facebook
  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const hours = ['6 AM', '9 AM', '12 PM', '3 PM', '6 PM', '9 PM']

  const matrix = daysOfWeek.map((day, dIdx) => {
    return hours.map((hour, hIdx) => {
      const score = profile[dIdx][hIdx]
      return {
        day,
        hour,
        score, // 0.0 to 1.0
        engagementIndex: Math.round(score * 100),
        avgEngagements: Math.round(score * 240 + 30),
      }
    })
  })

  return {
    hasEnoughData: true,
    daysCount: days,
    daysOfWeek,
    hours,
    matrix,
  }
}
