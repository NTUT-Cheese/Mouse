/**
 * Call Stack 程式解析器
 *
 * 將 Chrome (V8) / Firefox (SpiderMonkey) 的原始 stack trace 字串
 * 解析為結構化的 StackFrame 資料物件，並自動區分第三方套件與內嵌腳本。
 */

export interface ParsedStackFrame {
  /** 函式名稱 (如 fetchData, onClick 或 (anonymous)) */
  functionName: string;
  /** 完整的腳本 URL */
  fileUrl: string;
  /** 簡化的檔案名稱 (如 app.js, bundle.ts) */
  fileBasename: string;
  /** 行號 */
  lineNumber?: number;
  /** 欄位號碼 */
  columnNumber?: number;
  /** 格式化的行號字串 (如 L142:85) */
  lineCol: string;
  /** 是否為常見第三方庫/框架腳本 (如 React, Vue, jQuery, Axios 等) */
  isVendor: boolean;
  /** 是否為頁面內嵌腳本 (<inline script>) */
  isInline: boolean;
  /** 原始單行字串 */
  raw: string;
}

const VENDOR_PATTERNS = [
  /node_modules/,
  /vendor/i,
  /chunk-vendors/i,
  /jquery/i,
  /react(?:-dom)?/i,
  /vue(?:-router|x)?/i,
  /angular/i,
  /axios/i,
  /lodash/i,
  /bootstrap/i,
  /zone\.js/i,
  /webpack/i,
];

/**
 * 判斷 URL 是否為第三方庫/框架
 */
export function isVendorScript(url: string): boolean {
  return VENDOR_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * 抽取 URL 中的檔案簡短名稱
 */
export function extractBasename(fullUrl: string): string {
  if (!fullUrl) return '(unknown)';
  try {
    if (fullUrl.startsWith('http')) {
      const u = new URL(fullUrl);
      const pathSegments = u.pathname.split('/').filter(Boolean);
      const last = pathSegments[pathSegments.length - 1];
      return last || u.hostname || fullUrl;
    }
  } catch {
    // ignore
  }
  const noQuery = fullUrl.split('?')[0] || fullUrl;
  const clean = noQuery.split('#')[0] || noQuery;
  return clean.split('/').pop() || fullUrl;
}

/**
 * 主解析函式：程式化解析原始 Stack Trace 字串
 */
export function parseStackTrace(rawTrace?: string): ParsedStackFrame[] {
  if (!rawTrace) return [];

  const lines = rawTrace.split('\n').map((l) => l.trim()).filter(Boolean);

  return lines.map((line) => {
    let functionName = '(anonymous)';
    let fileUrl = '';
    let lineNumber: number | undefined;
    let columnNumber: number | undefined;

    // 1. 嘗試解析 Firefox 格式: fnName@https://example.com/script.js:123:45 或 @https://...
    const ffMatch = line.match(/^([^@]*)\@(.*)$/);
    if (ffMatch && ffMatch[2]) {
      functionName = ffMatch[1] ? ffMatch[1].trim() : '(anonymous)';
      const locationPart = ffMatch[2];
      const locMatch = locationPart.match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
      if (locMatch) {
        fileUrl = locMatch[1] || locationPart;
        if (locMatch[2]) lineNumber = parseInt(locMatch[2], 10);
        if (locMatch[3]) columnNumber = parseInt(locMatch[3], 10);
      } else {
        fileUrl = locationPart;
      }
    } else {
      // 2. 嘗試解析 Chrome/V8 格式: at fnName (https://example.com/script.js:123:45) 或 at https://...
      const chromeMatch = line.match(/^at\s+(?:([^\s(]+)\s+\((.*)\)|(.*))$/);
      if (chromeMatch) {
        functionName = chromeMatch[1] ? chromeMatch[1].trim() : '(anonymous)';
        const locationPart = chromeMatch[2] || chromeMatch[3] || '';
        const locMatch = locationPart.match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
        if (locMatch) {
          fileUrl = locMatch[1] || locationPart;
          if (locMatch[2]) lineNumber = parseInt(locMatch[2], 10);
          if (locMatch[3]) columnNumber = parseInt(locMatch[3], 10);
        } else {
          fileUrl = locationPart;
        }
      } else {
        fileUrl = line;
      }
    }

    const fileBasename = extractBasename(fileUrl);
    const lineCol = lineNumber ? `L${lineNumber}${columnNumber ? ':' + columnNumber : ''}` : '';
    const isVendor = isVendorScript(fileUrl);
    const isInline = !fileUrl.startsWith('http') && !fileUrl.startsWith('file');

    return {
      functionName,
      fileUrl,
      fileBasename,
      lineNumber,
      columnNumber,
      lineCol,
      isVendor,
      isInline,
      raw: line,
    };
  });
}
