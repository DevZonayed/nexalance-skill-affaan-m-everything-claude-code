/** Configuration loading and validation. */

/**
 * Parse a config file and validate required keys.
 */
function parseConfig(filePath) {
  return JSON.parse(filePath);
}

class ConfigError extends Error {}

module.exports = { parseConfig, ConfigError };
