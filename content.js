// content.js

// ==================== 禁用/启用控制与选择器 ====================
let enabled = true;                 // 当前页面解析是否启用
let observer = null;               // MutationObserver 实例
let isReversionRunning = false;    // 防止 revertAll 递归调用

// 支持登入状态（data-testid="tweetText"）与登出状态（Tailwind 样式容器）的推文文本选择器
const TWEET_TEXT_SELECTOR = [
  '[data-testid="tweetText"]:not(.x-md-container)',
  'div[dir="auto"].whitespace-pre-wrap.break-words:not(.x-md-container)',
  'div.font-chirp.whitespace-pre-wrap.break-words:not(.x-md-container)'
].join(', ');

// 判断某个节点是否为推文内容容器
function isTweetTextNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.classList && node.classList.contains('x-md-container')) return false;
  return node.matches && node.matches(TWEET_TEXT_SELECTOR);
}

// 清理单个 tweetNode 的相关状态和 observer
function cleanupTweet(tweetNode) {
  if (!tweetNode) return;
  if (tweetNode._xMdObserver) {
    tweetNode._xMdObserver.disconnect();
    delete tweetNode._xMdObserver;
  }
  if (tweetNode._updateTimer) {
    cancelAnimationFrame(tweetNode._updateTimer);
    delete tweetNode._updateTimer;
  }
  if (tweetNode._xMdContainer) {
    tweetNode._xMdContainer.remove();
    delete tweetNode._xMdContainer;
  }
  delete tweetNode._lastProcessedText;
  delete tweetNode.dataset.markdownProcessed;
  tweetNode.style.display = '';
}

// 恢复所有已解析的内容，还原原始 tweet
function revertAll() {
  if (isReversionRunning) return;
  isReversionRunning = true;

  const containers = document.querySelectorAll('.x-md-container');
  containers.forEach(container => {
    const originalTweet = container._xOriginalTweet ||
      (container.previousElementSibling && isTweetTextNode(container.previousElementSibling) ? container.previousElementSibling : null);

    if (originalTweet) {
      cleanupTweet(originalTweet);
    }
    container.remove();
  });

  // 确保页面上所有可能遗留标记的 tweetText 也被重置
  document.querySelectorAll(TWEET_TEXT_SELECTOR).forEach(tweetNode => {
    cleanupTweet(tweetNode);
  });

  isReversionRunning = false;
}

// 重新解析当前页面所有 tweet（当启用时）
function reparseAll() {
  if (!enabled) return;
  document.querySelectorAll(TWEET_TEXT_SELECTOR).forEach(tweetNode => {
    processTweet(tweetNode);
  });
}

// 初始化状态：向 background 查询当前标签页的禁用设置
async function initState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getInitialState' });
    const disabled = response.disabled;
    enabled = !disabled;
    if (!enabled) {
      // 如果初始状态是禁用，则立即恢复所有已解析的内容
      revertAll();
    } else {
      // 确保启用状态下重新解析可能遗漏的 tweet
      reparseAll();
    }
  } catch (err) {
    console.error('Failed to get initial state:', err);
  }
}

// 监听来自 background 的切换消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'disable') {
    if (enabled) {
      enabled = false;
      revertAll();
    }
    sendResponse({ status: 'disabled' });
  } else if (request.action === 'enable') {
    if (!enabled) {
      enabled = true;
      reparseAll();
    }
    sendResponse({ status: 'enabled' });
  }
  return true;
});

// ==================== 原有函数（稍作调整） ====================

// Set marked.js options
if (typeof marked !== 'undefined') {
    marked.setOptions({
        gfm: true,
        breaks: true,
        sanitize: false
    });
}

function renderMath(text, clonesMap) {
    if (typeof katex === 'undefined') return text;
    
    const delimiters = [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false }
    ];

    let res = text;
    for (const delim of delimiters) {
        let startIndex = 0;
        while ((startIndex = res.indexOf(delim.left, startIndex)) !== -1) {
            if (startIndex > 0 && res[startIndex - 1] === '\\') {
                startIndex += delim.left.length;
                continue;
            }
            const endIndex = res.indexOf(delim.right, startIndex + delim.left.length);
            if (endIndex === -1) break;
            if (res[endIndex - 1] === '\\') {
                startIndex = endIndex + delim.right.length;
                continue;
            }
            const mathStr = res.substring(startIndex + delim.left.length, endIndex);
            try {
                const html = katex.renderToString(mathStr, {
                    displayMode: delim.display,
                    throwOnError: false
                });
                const id = `XMDTOKEN${Math.random().toString(36).substr(2, 9)}X${clonesMap.size}X`;
                clonesMap.set(id, html);
                res = res.substring(0, startIndex) + id + res.substring(endIndex + delim.right.length);
                startIndex += id.length;
            } catch (e) {
                startIndex += delim.left.length;
            }
        }
    }
    res = res.replace(/\\(\$|\\\[|\\\]|\\\(|\\\))/g, '$1');
    return res;
}

// 判断元素是否为原子交互/多媒体元素（需完整保留在 clonesMap 中）
function isInteractiveOrMedia(child, isLatexed) {
  if (child.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = child.tagName;
  if (tag === 'A') {
    // X.com converts $E into cashtags. We flatten cashtags if in LaTeX mode!
    if (isLatexed && child.textContent.trim().startsWith('$')) {
      return false;
    }
    return true;
  }
  if (tag === 'BUTTON' || tag === 'IMG') {
    return true;
  }
  const role = child.getAttribute('role');
  if (role === 'button' || role === 'link') {
    return true;
  }
  if (child.getAttribute('data-testid') === 'tweet-text-show-more-link') {
    return true;
  }
  if (child.hasAttribute('tabindex')) {
    return true;
  }
  return false;
}

// 获取 <a> 标签的实际目标 URL（优先使用 title 或 data-expanded-url 提取完整未截断 URL）
function getLinkUrl(aElement) {
  if (!aElement || aElement.tagName !== 'A') return null;
  const title = aElement.getAttribute('title');
  if (title && /^https?:\/\//i.test(title.trim())) {
    return title.trim();
  }
  const expanded = aElement.getAttribute('data-expanded-url');
  if (expanded && /^https?:\/\//i.test(expanded.trim())) {
    return expanded.trim();
  }
  const href = aElement.getAttribute('href');
  if (href && /^https?:\/\//i.test(href.trim())) {
    return href.trim();
  }
  const text = aElement.textContent.trim().replace(/[…\.\s]+$/, '');
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return href || null;
}

// 为 container 设置事件委托
function setupContainerEvents(markdownContainer) {
  markdownContainer.addEventListener('click', (e) => {
    // 1. 检查是否点击了带 data-xmd-id 的原始克隆元素（例如链接、展开帖子按钮、表情等）
    const interactiveTarget = e.target.closest('[data-xmd-id]');
    if (interactiveTarget) {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(interactiveTarget.getAttribute('data-xmd-id'), 10);
      const originalNode = markdownContainer._clonedElements && markdownContainer._clonedElements[id];
      if (originalNode) {
        // 触发原始节点的原生点击事件（包括 React 绑定的事件，如展开帖子）
        originalNode.click();
      }
      return;
    }

    // 2. 检查是否点击了 Markdown 文本中自动生成的链接（[text](url)）
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute('href');
      if (href) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    // 3. 用户点击推文空白或普通文字
    // 若正在选中文本（复制），不干扰
    const selection = window.getSelection ? window.getSelection().toString() : '';
    if (selection && selection.trim().length > 0) {
      return;
    }
    // 允许事件冒泡到父层 tweet card，保持原生推文卡片跳转体验
  });
}

function processTweet(tweetNode) {
  if (!enabled) return;
  if (!tweetNode || !tweetNode.parentNode) return;
  if (tweetNode.classList && tweetNode.classList.contains('x-md-container')) return;
  if (tweetNode.closest && tweetNode.closest('.x-md-container')) return;

  const currentText = tweetNode.textContent;
  const isProcessed = tweetNode.dataset.markdownProcessed === "true";
  const existingContainer = tweetNode._xMdContainer;

  // 如果内容未变且容器依然在 DOM 中，无需重新解析
  if (isProcessed &&
      tweetNode._lastProcessedText === currentText &&
      existingContainer &&
      document.body.contains(existingContainer)) {
    return;
  }

  const isLatexed = /#latexed/i.test(currentText);
  let text = "";
  const clonesMap = new Map();
  const clonedElements = [];

  function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.nodeValue;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        // 如果当前 <a> 处于 Markdown 链接或图片语法目标位置（如 `[title](` 或 `![alt](` 或 `[id]: `）
        const isMarkdownLinkTarget = /(?:!?\[[^\]]*\]\s*\(\<?)$/.test(text) || /(?:\[[^\]]*\]:\s*)$/.test(text);
        if (child.tagName === 'A' && isMarkdownLinkTarget) {
          const linkUrl = getLinkUrl(child);
          if (linkUrl) {
            text += linkUrl;
            continue;
          }
        }

        if (isInteractiveOrMedia(child, isLatexed)) {
          const token = `XMDTOKEN${Math.random().toString(36).substr(2, 9)}X${clonedElements.length}X`;
          const clone = child.cloneNode(true);
          clone.setAttribute('data-xmd-id', String(clonedElements.length));
          clonedElements.push(child);
          clonesMap.set(token, clone.outerHTML);
          text += token;
        } else if (child.tagName === 'BR') {
          text += "\n";
        } else {
          walk(child);
        }
      }
    }
  }

  walk(tweetNode);

  // 若推文无文字内容，清理可能存在的旧容器
  if (!text.trim()) {
    if (existingContainer) {
      existingContainer.remove();
      delete tweetNode._xMdContainer;
    }
    tweetNode.style.display = '';
    delete tweetNode.dataset.markdownProcessed;
    delete tweetNode._lastProcessedText;
    return;
  }

  if (isLatexed) {
    text = renderMath(text, clonesMap);
  }

  let parsedHtml = "";
  try {
    parsedHtml = marked.parse(text);
  } catch (e) {
    console.error("Markdown parsing failed:", e);
    return;
  }

  for (const [token, html] of clonesMap.entries()) {
    parsedHtml = parsedHtml.split(token).join(html);
  }

  let markdownContainer = existingContainer;
  const containerInDoc = markdownContainer && document.body.contains(markdownContainer);

  if (!containerInDoc) {
    // 移除可能存在的孤儿容器
    if (tweetNode.nextElementSibling && tweetNode.nextElementSibling.classList.contains('x-md-container')) {
      tweetNode.nextElementSibling.remove();
    }
    markdownContainer = document.createElement('div');
    markdownContainer.className = 'x-md-container';
    markdownContainer.setAttribute('dir', 'auto');
    if (tweetNode.className) {
      markdownContainer.className += ' ' + tweetNode.className;
    }
    tweetNode.parentNode.insertBefore(markdownContainer, tweetNode.nextSibling);
    setupContainerEvents(markdownContainer);
  } else {
    // 保持 class 同步
    if (tweetNode.className) {
      markdownContainer.className = 'x-md-container ' + tweetNode.className;
    }
  }

  const computedStyle = window.getComputedStyle(tweetNode);
  if (computedStyle && computedStyle.color) {
    markdownContainer.style.color = computedStyle.color;
  }

  markdownContainer.innerHTML = parsedHtml;
  markdownContainer._clonedElements = clonedElements;
  markdownContainer._xOriginalTweet = tweetNode;
  tweetNode._xMdContainer = markdownContainer;
  tweetNode._lastProcessedText = currentText;

  // 隐藏原始 tweetNode 并标记已处理
  tweetNode.dataset.markdownProcessed = "true";
  tweetNode.style.display = 'none';

  // 监听 tweetNode 本身的变化（Grok 翻译、展开/折叠、React 重渲染样式重置等）
  if (!tweetNode._xMdObserver) {
    tweetNode._xMdObserver = new MutationObserver(() => {
      if (!enabled) return;

      // 防止 React 重新渲染时清除 display: none
      if (tweetNode.style.display !== 'none') {
        tweetNode.style.display = 'none';
      }
      if (tweetNode.dataset.markdownProcessed !== 'true') {
        tweetNode.dataset.markdownProcessed = 'true';
      }

      // 防抖触发更新
      if (tweetNode._updateTimer) {
        cancelAnimationFrame(tweetNode._updateTimer);
      }
      tweetNode._updateTimer = requestAnimationFrame(() => {
        tweetNode._updateTimer = null;
        processTweet(tweetNode);
      });
    });

    tweetNode._xMdObserver.observe(tweetNode, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-markdown-processed']
    });
  }
}

// 修改 observer 回调，检查 enabled 状态
const observerCallback = (mutations) => {
  if (!enabled) return;
  for (const mutation of mutations) {
    if (mutation.addedNodes.length) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 忽略本插件自建容器及其内部变化
          if (node.classList && node.classList.contains('x-md-container')) continue;
          if (node.closest && node.closest('.x-md-container')) continue;

          if (isTweetTextNode(node)) {
            processTweet(node);
          }
          const tweetTexts = node.querySelectorAll ? node.querySelectorAll(TWEET_TEXT_SELECTOR) : [];
          tweetTexts.forEach(processTweet);
        }
      }
    }
    if (mutation.removedNodes.length) {
      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 忽略本插件容器
          if (node.classList && node.classList.contains('x-md-container')) continue;

          if (isTweetTextNode(node)) {
            cleanupTweet(node);
          }
          const tweetTexts = node.querySelectorAll ? node.querySelectorAll(TWEET_TEXT_SELECTOR) : [];
          tweetTexts.forEach(cleanupTweet);
        }
      }
    }
  }
};

// 启动 observer
function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(observerCallback);
  observer.observe(document.body, { childList: true, subtree: true });
}

// 页面加载完成后，初始化状态、启动 observer 并处理现有节点
async function main() {
  await initState();
  startObserver();
  if (enabled) {
    document.querySelectorAll(TWEET_TEXT_SELECTOR).forEach(processTweet);
  }
}

main();