import type { Env } from "../../config/env.js";
import { fetchText } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";

export interface ArticleDocument {
  sourceUrl: string;
  title?: string;
  excerpt?: string;
  text: string;
  extractionMethod: string;
  confidence: number;
  warnings: string[];
  imageCandidates?: string[];
  imageDriven?: boolean;
}

interface HtmlCandidate {
  label: string;
  html: string;
}

interface SiteRule {
  matchHost: RegExp;
  selectors: Array<{
    label: string;
    pattern: RegExp;
    groupIndex?: number;
  }>;
}

interface ScoredCandidate {
  label: string;
  html: string;
  text: string;
  score: number;
  paragraphCount: number;
  linkDensity: number;
  warnings: string[];
}

const noiseKeywordPattern =
  /related|recommended|popular|comment|comments|newsletter|advertisement|sponsored|privacy policy|cookie|login|sign up|register|上一篇|下一篇|相关阅读|相关推荐|热门推荐|评论|留言|广告|赞助|订阅|注册|登录|版权|免责声明|隐私政策/gi;

const siteRules: SiteRule[] = [
  {
    matchHost: /(^|\.)mp\.weixin\.qq\.com$/i,
    selectors: [
      {
        label: "wechat_rich_media_content",
        pattern: /<div[^>]+class=["'][^"']*rich_media_content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      },
      {
        label: "wechat_page_content",
        pattern: /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i
      }
    ]
  },
  {
    matchHost: /(^|\.)medium\.com$/i,
    selectors: [
      {
        label: "medium_article",
        pattern: /<article\b[^>]*>([\s\S]*?)<\/article>/i
      }
    ]
  },
  {
    matchHost: /(^|\.)substack\.com$/i,
    selectors: [
      {
        label: "substack_body",
        pattern: /<div[^>]+class=["'][^"']*body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      },
      {
        label: "substack_markup",
        pattern: /<div[^>]+class=["'][^"']*markup[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      }
    ]
  },
  {
    matchHost: /(^|\.)github\.com$/i,
    selectors: [
      {
        label: "github_markdown",
        pattern: /<article[^>]+class=["'][^"']*markdown-body[^"']*["'][^>]*>([\s\S]*?)<\/article>/i
      },
      {
        label: "github_readme",
        pattern: /<div[^>]+id=["']readme["'][^>]*>([\s\S]*?)<\/div>/i
      }
    ]
  }
];

export class ArticleFetcher {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {}

  async fetchDocuments(urls: string[]) {
    const documents: ArticleDocument[] = [];

    for (const sourceUrl of urls) {
      try {
        const document = await this.fetchDocument(sourceUrl);
        documents.push(document);
      } catch (error) {
        this.logger.warn("article_fetch.failed", {
          sourceUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return documents;
  }

  private async fetchDocument(sourceUrl: string): Promise<ArticleDocument> {
    const html = await fetchText(sourceUrl, {
      method: "GET",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        "user-agent": "FeishuLocalAI/0.1 (+https://local)"
      }
    });

    const title = extractTitle(html);
    const excerpt = extractExcerpt(html);
    const scored = selectBestCandidate(sourceUrl, html);
    const text = scored.text.slice(0, 12_000);
    const imageCandidates = extractImageCandidates(sourceUrl, scored.html, html);
    const imageDriven = isImageDrivenDocument(text, imageCandidates);
    const warnings = dedupeWarnings([
      ...scored.warnings,
      ...(title ? [] : ["missing_title"]),
      ...(excerpt ? [] : ["missing_excerpt"]),
      ...(text.length < 400 ? ["short_content"] : []),
      ...(imageDriven ? ["image_heavy_content"] : [])
    ]);

    const document: ArticleDocument = {
      sourceUrl,
      text,
      extractionMethod: scored.label,
      confidence: clampConfidence(scored.score / 100),
      warnings,
      ...(imageCandidates.length > 0 ? { imageCandidates } : {}),
      ...(imageDriven ? { imageDriven } : {})
    };

    if (title) {
      document.title = title;
    }
    if (excerpt) {
      document.excerpt = excerpt;
    }

    this.logger.info("article_fetch.extracted", {
      sourceUrl,
      extractionMethod: document.extractionMethod,
      confidence: document.confidence,
      imageCandidateCount: imageCandidates.length,
      imageDriven,
      warningCount: document.warnings.length,
      textLength: document.text.length
    });

    return document;
  }
}

function extractTitle(html: string) {
  const candidates = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = normalizeInlineText(match[1]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function extractExcerpt(html: string) {
  const candidates = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = normalizeInlineText(match[1]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function selectBestCandidate(sourceUrl: string, html: string): ScoredCandidate {
  const candidates = collectHtmlCandidates(sourceUrl, html);
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate))
    .filter((candidate) => candidate.text.length > 120)
    .sort((left, right) => right.score - left.score);

  const bestCandidate = scored[0];
  if (bestCandidate) {
    return bestCandidate;
  }

  return {
    label: "full_document_fallback",
    html,
    text: extractArticleText(html).slice(0, 12_000),
    score: 18,
    paragraphCount: 1,
    linkDensity: 0,
    warnings: ["fallback_full_document"]
  };
}

function collectHtmlCandidates(sourceUrl: string, html: string): HtmlCandidate[] {
  const candidates: HtmlCandidate[] = [];
  const siteRule = resolveSiteRule(sourceUrl);

  if (siteRule) {
    for (const selector of siteRule.selectors) {
      candidates.push(...collectMatches(html, selector.pattern, selector.label, selector.groupIndex ?? 1));
    }
  }

  candidates.push(...collectMatches(html, /<article\b[^>]*>([\s\S]*?)<\/article>/gi, "article"));
  candidates.push(...collectMatches(html, /<main\b[^>]*>([\s\S]*?)<\/main>/gi, "main"));
  candidates.push(
    ...collectMatches(
      html,
      /<(section|div)[^>]+(?:id|class)=["'][^"']*(?:content|article|post|entry|main|body|detail|markdown-body|rich_media_content)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
      "content_selector",
      2
    )
  );

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    candidates.push({
      label: "body",
      html: bodyMatch[1]
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      label: "document",
      html
    });
  }

  return dedupeCandidates(candidates);
}

function resolveSiteRule(sourceUrl: string) {
  try {
    const host = new URL(sourceUrl).hostname;
    return siteRules.find((rule) => rule.matchHost.test(host));
  } catch {
    return undefined;
  }
}

function collectMatches(
  html: string,
  pattern: RegExp,
  label: string,
  groupIndex = 1
) {
  return Array.from(html.matchAll(pattern))
    .map((match) => match[groupIndex])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => ({
      label,
      html: value
    }));
}

function dedupeCandidates(candidates: HtmlCandidate[]) {
  const seen = new Set<string>();
  const result: HtmlCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.html.replace(/\s+/g, " ").trim();
    const key = normalized.slice(0, 500);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function scoreCandidate(candidate: HtmlCandidate): ScoredCandidate {
  const cleanedHtml = stripNoiseBlocks(candidate.html);
  const text = extractArticleText(cleanedHtml);
  const paragraphs = splitParagraphs(text);
  const paragraphCount = paragraphs.length;
  const textLength = text.length;
  const linkCount = countMatches(candidate.html, /<a\b/gi);
  const linkDensity = textLength > 0 ? linkCount / Math.max(textLength / 120, 1) : 1;
  const noiseCount = countMatches(text, noiseKeywordPattern);

  let score = 0;
  score += Math.min(textLength / 80, 42);
  score += Math.min(paragraphCount * 3, 24);
  score += candidate.label === "article" ? 18 : 0;
  score += candidate.label === "main" ? 12 : 0;
  score += candidate.label === "content_selector" ? 10 : 0;
  score += candidate.label.startsWith("wechat_") ? 16 : 0;
  score += candidate.label.startsWith("substack_") ? 12 : 0;
  score += candidate.label.startsWith("github_") ? 12 : 0;
  score += candidate.label.startsWith("medium_") ? 10 : 0;
  score -= Math.min(linkDensity * 8, 25);
  score -= noiseCount * 4;
  score -= paragraphCount <= 1 ? 10 : 0;
  score -= textLength < 300 ? 12 : 0;

  const warnings: string[] = [];
  if (paragraphCount <= 1) warnings.push("low_paragraph_count");
  if (textLength < 300) warnings.push("short_candidate");
  if (linkDensity > 1.2) warnings.push("high_link_density");
  if (noiseCount > 0) warnings.push("noise_keywords_detected");

  return {
    label: candidate.label,
    html: candidate.html,
    text,
    score,
    paragraphCount,
    linkDensity,
    warnings
  };
}

function stripNoiseBlocks(html: string) {
  return html
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extractArticleText(html: string) {
  const body = stripNoiseBlocks(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|article|section|h1|h2|h3|h4|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(body)
    .replace(/\r/g, " ")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\b(Home|About|Privacy Policy|Cookie Policy|Terms of Service)\b/gi, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 40);
}

function normalizeInlineText(text: string) {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

function countMatches(value: string, pattern: RegExp) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function clampConfidence(value: number) {
  return Math.max(0.1, Math.min(0.98, Number(value.toFixed(2))));
}

function isImageDrivenDocument(text: string, imageCandidates: string[]) {
  if (imageCandidates.length === 0) {
    return false;
  }

  return text.length < 500 || (text.length < 1_500 && imageCandidates.length >= 3);
}

function extractImageCandidates(sourceUrl: string, preferredHtml: string, fullHtml: string) {
  const sources = [preferredHtml, fullHtml];
  const candidates: string[] = [];

  for (const html of sources) {
    const matches = html.matchAll(
      /<img\b[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>/gi
    );

    for (const match of matches) {
      const rawUrl = match[1];
      if (!rawUrl) {
        continue;
      }
      const normalized = normalizeImageUrl(sourceUrl, rawUrl);
      if (!normalized || isNoiseImage(normalized)) {
        continue;
      }
      candidates.push(normalized);
    }
  }

  return Array.from(new Set(candidates)).slice(0, 6);
}

function normalizeImageUrl(sourceUrl: string, value: string) {
  const raw = decodeHtmlEntities(value).trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
    return undefined;
  }

  try {
    if (raw.startsWith("//")) {
      return `https:${raw}`;
    }
    return new URL(raw, sourceUrl).toString();
  } catch {
    return undefined;
  }
}

function isNoiseImage(url: string) {
  return /avatar|icon|logo|emoji|wx_fmt=gif|qrcode|qr_code|badge|sprite/i.test(url);
}

function dedupeWarnings(warnings: string[]) {
  return Array.from(new Set(warnings.filter(Boolean)));
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}
