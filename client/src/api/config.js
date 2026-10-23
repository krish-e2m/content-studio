// =============================================================================
// src/api/config.js
// Configuration for the Performance API layer.
// Controls DATA_SOURCE ('mock' | 'live') and triggerable mock scenarios.
// =============================================================================

export const DATA_SOURCE = import.meta.env.VITE_DATA_SOURCE || 'mock'

let activeMockScenario = null // null | 'rate_limit' | 'auth_expired' | 'empty'

export function getApiConfig() {
  return {
    dataSource: DATA_SOURCE,
    mockScenario: activeMockScenario,
  }
}

export function setMockScenario(scenario) {
  // scenario: null | 'rate_limit' | 'auth_expired' | 'empty'
  activeMockScenario = scenario
}
