export const X_TAB_URL_PATTERNS = ["https://x.com/*", "https://twitter.com/*"];

export const ARTICLE_TABS_KEY = "article-tabs";
export const ARTICLE_WORKER_TAB_KEY = "article-worker-tab";
export const ARTICLE_TEMPLATE_KEY = "article-request-template";
export const ARTICLE_TIMEOUT_PREFIX = "bp-article-timeout:";
export const CAPTURE_SCROLL_KEY = "bp-capture-scroll-active";

/** Max local pending before pulling more from the server. */
export const ARTICLE_LOCAL_QUEUE_CAP = 50;
/** Server pull when the local article queue is empty / topping up. */
export const ARTICLE_SERVER_PULL_EMPTY = 50;
export const ARTICLE_SERVER_PULL_TOPUP = 25;
