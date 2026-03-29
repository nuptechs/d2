// ============================================================
// Traffic Filter — URL inclusion/exclusion and extension filtering
// ============================================================

import type { NetworkConfig } from '@probe/core';

interface CompiledFilter {
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
  excludeExtensions: Set<string>;
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports `*` (any non-slash chars) and `**` (any chars including slashes).
 */
function globToRegex(pattern: string): RegExp {
  let escaped = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*' && pattern[i + 1] === '*') {
      escaped += '.*';
      i += 2;
      // Skip a trailing slash after **
      if (pattern[i] === '/') i++;
    } else if (char === '*') {
      escaped += '[^/]*';
      i++;
    } else if (char === '?') {
      escaped += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      escaped += '\\' + char;
      i++;
    } else {
      escaped += char;
      i++;
    }
  }

  return new RegExp(`^${escaped}$`, 'i');
}

function compileFilter(config: NetworkConfig): CompiledFilter {
  const includePatterns = (config.includeUrls ?? []).map(globToRegex);
  const excludePatterns = (config.excludeUrls ?? []).map(globToRegex);
  const excludeExtensions = new Set(
    (config.excludeExtensions ?? []).map(ext =>
      ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
    ),
  );

  return { includePatterns, excludePatterns, excludeExtensions };
}

function getUrlExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return '';
    const ext = pathname.slice(lastDot).toLowerCase();
    // Strip query-string fragments that might leak through
    const qMark = ext.indexOf('?');
    return qMark === -1 ? ext : ext.slice(0, qMark);
  } catch {
    // Fallback for relative URLs
    const lastDot = url.lastIndexOf('.');
    if (lastDot === -1) return '';
    return url.slice(lastDot).split(/[?#]/)[0]?.toLowerCase() ?? '';
  }
}

/**
 * Create a traffic filter function based on NetworkConfig.
 * Returns `true` if the URL should be captured.
 */
export function createTrafficFilter(config: NetworkConfig): (url: string) => boolean {
  const { includePatterns, excludePatterns, excludeExtensions } = compileFilter(config);

  return (url: string): boolean => {
    // Check extension exclusion first (cheapest check)
    if (excludeExtensions.size > 0) {
      const ext = getUrlExtension(url);
      if (ext && excludeExtensions.has(ext)) return false;
    }

    // If include patterns exist, URL must match at least one
    if (includePatterns.length > 0) {
      const included = includePatterns.some(re => re.test(url));
      if (!included) return false;
    }

    // If exclude patterns exist, URL must not match any
    if (excludePatterns.length > 0) {
      const excluded = excludePatterns.some(re => re.test(url));
      if (excluded) return false;
    }

    return true;
  };
}
