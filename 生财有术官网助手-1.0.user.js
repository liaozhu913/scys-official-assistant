// ==UserScript==
// @name         生财有术官网助手
// @namespace    https://scys.com/
// @version      1.0
// @description  图片增强：点击生财有术官网内容图片即可放大查看、自由缩放、拖拽平移并切换上下张；私用 Markdown 功能需密钥解锁。
// @author       料主（liaozhu913）
// @match        https://scys.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NS = 'scys-helper';
    const HMAC_SECRET = 'NW_LICENSE_KEY_2026_AntiGravity#$%';
    const UNLOCK_STORAGE_KEY = 'scys-helper-md-unlock-key';
    const DEVICE_STORAGE_KEY = 'scys-helper-device-code';
    const MD_BAR_VISIBLE_STORAGE_KEY = 'scys-helper-mdbar-visible';
    const UNLOCK_PREFIX = 'SCYS-MD';
    const UNLOCK_PRODUCT = 'SCYS_OFFICIAL_ASSISTANT';
    const UNLOCK_FEATURE = 'MD_UNLOCK_V2';

    const VIEWABLE_SELECTORS = [
        'img.multi-img',
        'img.simple-img',
        'img.single-img',
        'img.image',
        '.image-list img',
        '.case-images img',
        '.single-image img',
        '.block-image img',
        '.s-image img'
    ];

    const BLOCKED_PATTERNS = [
        'avatar',
        'logo',
        'advanced-icon',
        'comment-avatar',
        'vc-user-avatar',
        'anchor-info-box'
    ];

    const HEADING_LEVELS = [
        ['doc-heading-2', 2],
        ['doc-heading-3', 3],
        ['doc-heading-4', 4],
        ['doc-heading-5', 5],
        ['doc-heading-6', 6],
    ];

    const encoder = new TextEncoder();
    let hmacKeyPromise = null;

    const viewer = {
        overlay: null,
        image: null,
        stage: null,
        counter: null,
        caption: null,
        items: [],
        index: 0,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        startX: 0,
        startY: 0,
        baseX: 0,
        baseY: 0
    };

    function qs(selector, root = document) {
        return root.querySelector(selector);
    }

    function qsa(selector, root = document) {
        return Array.from(root.querySelectorAll(selector));
    }

    function hasClass(element, className) {
        return !!element && element.classList && element.classList.contains(className);
    }

    function textOf(element) {
        return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function getClassText(value) {
        if (!value) return '';
        return typeof value === 'string' ? value : String(value);
    }

    function getImageUrl(img) {
        return img.currentSrc || img.src || img.getAttribute?.('data-src') || '';
    }

    function normalizeImageUrl(rawUrl) {
        if (!rawUrl) return rawUrl;

        let url;
        try {
            url = new URL(rawUrl, window.location.href);
        } catch (error) {
            return rawUrl;
        }

        const processValue = url.searchParams.get('x-oss-process');
        if (processValue) {
            const nextProcess = processValue
                .replace(/resize,m_lfit,w_\d+,h_\d+/i, 'resize,m_lfit,w_2400,h_16000')
                .replace(/resize,m_fill,w_\d+,h_\d+/i, 'resize,m_lfit,w_2400,h_16000')
                .replace(/quality,q_\d+/i, 'quality,q_95')
                .replace(/\/format,webp/ig, '')
                .replace(/format,webp\/?/ig, '')
                .replace(/\/{2,}/g, '/')
                .replace(/\/$/g, '');
            url.searchParams.set('x-oss-process', nextProcess);
        }

        return url.href;
    }

    function isViewableImage(img) {
        if (!img) return false;

        const url = getImageUrl(img);
        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;

        const classText = [
            getClassText(img.className),
            getClassText(img.parentElement && img.parentElement.className),
            img.alt || ''
        ].join(' ').toLowerCase();

        if (BLOCKED_PATTERNS.some(pattern => classText.includes(pattern))) return false;
        if (/头像|logo|用户头像|投锚用户头像/i.test(img.alt || '')) return false;

        const explicitContentImage = VIEWABLE_SELECTORS.some(selector => {
            try {
                return img.matches?.(selector);
            } catch (error) {
                return false;
            }
        });

        if (explicitContentImage) return true;

        const width = img.naturalWidth || img.clientWidth || 0;
        const height = img.naturalHeight || img.clientHeight || 0;
        return width >= 300 && height >= 300;
    }

    function addStyles() {
        const css = `
            .${SCRIPT_NS}-image-enabled { cursor: zoom-in !important; }
            .${SCRIPT_NS}-viewer-lock { overflow: hidden !important; }
            .${SCRIPT_NS}-viewer {
                position: fixed; inset: 0; z-index: 2147483647; display: none;
                background: rgba(12, 16, 18, 0.92); color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; user-select: none;
            }
            .${SCRIPT_NS}-viewer.is-open { display: block; }
            .${SCRIPT_NS}-stage { position: absolute; inset: 48px 64px 54px; overflow: hidden; }
            .${SCRIPT_NS}-img {
                position: absolute; left: 50%; top: 50%; max-width: none; max-height: none;
                transform-origin: center center; will-change: transform; cursor: grab;
                box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
            }
            .${SCRIPT_NS}-img.is-dragging { cursor: grabbing; }
            .${SCRIPT_NS}-toolbar {
                position: absolute; left: 0; right: 0; top: 0; height: 48px;
                display: flex; align-items: center; justify-content: space-between;
                padding: 0 16px; box-sizing: border-box;
                background: linear-gradient(to bottom, rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0));
            }
            .${SCRIPT_NS}-actions, .${SCRIPT_NS}-zoom { display: flex; align-items: center; gap: 8px; }
            .${SCRIPT_NS}-viewer button {
                min-width: 36px; height: 34px; border: 1px solid rgba(255, 255, 255, 0.28);
                border-radius: 6px; color: #fff; background: rgba(255, 255, 255, 0.12);
                font-size: 15px; line-height: 1; cursor: pointer;
            }
            .${SCRIPT_NS}-viewer button:hover { background: rgba(255, 255, 255, 0.22); }
            .${SCRIPT_NS}-counter { min-width: 78px; text-align: center; font-size: 14px; color: rgba(255, 255, 255, 0.86); }
            .${SCRIPT_NS}-caption {
                position: absolute; left: 16px; right: 16px; bottom: 14px; height: 26px;
                overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap;
                color: rgba(255, 255, 255, 0.72); font-size: 13px;
            }
            .${SCRIPT_NS}-side { position: absolute; top: 50%; width: 44px; height: 72px; margin-top: -36px; font-size: 30px; }
            .${SCRIPT_NS}-prev { left: 14px; }
            .${SCRIPT_NS}-next { right: 14px; }
            .${SCRIPT_NS}-toast {
                position: fixed; left: 50%; bottom: 36px; z-index: 2147483647;
                transform: translateX(-50%) translateY(12px); padding: 8px 12px;
                border-radius: 6px; background: rgba(17, 24, 39, 0.92);
                color: #fff; font-size: 13px; opacity: 0; pointer-events: none;
                transition: opacity 0.18s ease, transform 0.18s ease;
            }
            .${SCRIPT_NS}-toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
            .${SCRIPT_NS}-toast[data-type="error"] { background: rgba(185, 28, 28, 0.94); }
            .${SCRIPT_NS}-advanced-mask {
                position: fixed; inset: 0; z-index: 2147483646; display: none;
                background: rgba(15, 23, 42, 0.38);
            }
            .${SCRIPT_NS}-advanced-mask.is-visible { display: block; }
            .${SCRIPT_NS}-advanced-panel {
                position: fixed; left: 50%; top: 50%; z-index: 2147483647;
                width: min(520px, calc(100vw - 28px)); transform: translate(-50%, -50%);
                border-radius: 8px; background: #fff; color: #111827;
                box-shadow: 0 24px 80px rgba(15, 23, 42, 0.34);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                padding: 16px;
            }
            .${SCRIPT_NS}-advanced-panel h3 { margin: 0 0 10px; font-size: 17px; }
            .${SCRIPT_NS}-advanced-panel p { margin: 0 0 12px; color: #4b5563; font-size: 13px; line-height: 1.6; }
            .${SCRIPT_NS}-advanced-panel label { display: block; margin: 10px 0 6px; color: #374151; font-size: 13px; }
            .${SCRIPT_NS}-advanced-row { display: flex; gap: 8px; align-items: stretch; }
            .${SCRIPT_NS}-advanced-panel input {
                flex: 1; min-width: 0; border: 1px solid #d1d5db; border-radius: 6px;
                padding: 9px 10px; color: #111827; background: #fff; font-size: 13px;
            }
            .${SCRIPT_NS}-advanced-panel input[readonly] { background: #f9fafb; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            .${SCRIPT_NS}-advanced-toggle {
                display: flex !important; align-items: center; gap: 8px; margin-top: 12px !important;
                color: #374151 !important; line-height: 1.4;
            }
            .${SCRIPT_NS}-advanced-toggle input {
                flex: 0 0 auto; width: 16px; height: 16px; margin: 0; padding: 0;
            }
            .${SCRIPT_NS}-advanced-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
            .${SCRIPT_NS}-advanced-panel button {
                width: auto; min-width: 82px; height: 36px; border: 1px solid #d1d5db; border-radius: 6px;
                background: #fff; color: #111827; cursor: pointer; font-size: 13px;
            }
            .${SCRIPT_NS}-advanced-panel button[data-primary="true"] { border-color: #059669; background: #059669; color: #fff; }
            .${SCRIPT_NS}-mdbar {
                position: fixed; right: 18px; bottom: 86px; z-index: 2147483600;
                display: none; flex-direction: column; gap: 8px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .${SCRIPT_NS}-mdbar.is-visible { display: flex; }
            .${SCRIPT_NS}-mdbar button {
                min-width: 92px; height: 34px; padding: 0 12px; border: 1px solid rgba(17, 24, 39, 0.14);
                border-radius: 6px; background: rgba(255, 255, 255, 0.96); color: #111827;
                box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); cursor: pointer; font-size: 13px;
            }
            .${SCRIPT_NS}-mdbar button:hover { background: #f8fafc; }
            @media (max-width: 720px) {
                .${SCRIPT_NS}-stage { inset: 50px 12px 54px; }
                .${SCRIPT_NS}-side { width: 38px; height: 58px; font-size: 24px; }
                .${SCRIPT_NS}-mdbar { right: 12px; bottom: 72px; }
            }
        `;

        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
        } else {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    function createButton(label, title, onClick, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.title = title;
        button.className = className;
        button.addEventListener('click', event => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = `${SCRIPT_NS}-viewer`;

        const toolbar = document.createElement('div');
        toolbar.className = `${SCRIPT_NS}-toolbar`;
        const actions = document.createElement('div');
        actions.className = `${SCRIPT_NS}-actions`;
        actions.appendChild(createButton('-', '缩小', () => zoomBy(0.85)));
        actions.appendChild(createButton('+', '放大', () => zoomBy(1.18)));
        actions.appendChild(createButton('1:1', '原始大小', () => setScale(1)));
        actions.appendChild(createButton('适应', '适应窗口', resetView));

        viewer.counter = document.createElement('div');
        viewer.counter.className = `${SCRIPT_NS}-counter`;
        const zoom = document.createElement('div');
        zoom.className = `${SCRIPT_NS}-zoom`;
        zoom.appendChild(viewer.counter);
        zoom.appendChild(createButton('×', '关闭', closeViewer));
        toolbar.appendChild(actions);
        toolbar.appendChild(zoom);

        viewer.stage = document.createElement('div');
        viewer.stage.className = `${SCRIPT_NS}-stage`;
        viewer.image = document.createElement('img');
        viewer.image.className = `${SCRIPT_NS}-img`;
        viewer.image.alt = '';
        viewer.image.draggable = false;
        viewer.image.addEventListener('load', resetView);
        viewer.stage.appendChild(viewer.image);

        viewer.caption = document.createElement('div');
        viewer.caption.className = `${SCRIPT_NS}-caption`;

        overlay.appendChild(toolbar);
        overlay.appendChild(viewer.stage);
        overlay.appendChild(createButton('‹', '上一张', () => showAt(viewer.index - 1), `${SCRIPT_NS}-side ${SCRIPT_NS}-prev`));
        overlay.appendChild(createButton('›', '下一张', () => showAt(viewer.index + 1), `${SCRIPT_NS}-side ${SCRIPT_NS}-next`));
        overlay.appendChild(viewer.caption);

        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeViewer();
        });
        overlay.addEventListener('wheel', onWheel, { passive: false });
        viewer.stage.addEventListener('mousedown', onDragStart);
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragEnd);
        window.addEventListener('keydown', onKeyDown);

        document.body.appendChild(overlay);
        viewer.overlay = overlay;
    }

    function collectImages(clickedImage) {
        const group = clickedImage.closest?.('.image-list, .case-images, .single-image, .post-item, .money-ideas-detail, .feishu-doc-content, .content-container');
        const candidates = group ? qsa('img', group) : qsa(VIEWABLE_SELECTORS.join(','));
        const items = candidates
            .filter(isViewableImage)
            .map(img => ({ element: img, url: normalizeImageUrl(getImageUrl(img)), alt: img.alt || img.title || '生财有术图片' }))
            .filter(item => item.url);

        const deduped = [];
        const seen = new Set();
        for (const item of items) {
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            deduped.push(item);
        }

        const clickedUrl = normalizeImageUrl(getImageUrl(clickedImage));
        const clickedIndex = Math.max(0, deduped.findIndex(item => item.url === clickedUrl));
        return { items: deduped.length ? deduped : [{ element: clickedImage, url: clickedUrl, alt: clickedImage.alt || '生财有术图片' }], index: clickedIndex };
    }

    function openViewer(clickedImage) {
        if (!viewer.overlay) createOverlay();
        const gallery = collectImages(clickedImage);
        viewer.items = gallery.items;
        viewer.index = gallery.index;
        viewer.overlay.classList.add('is-open');
        document.body.classList.add(`${SCRIPT_NS}-viewer-lock`);
        showAt(viewer.index);
    }

    function closeViewer() {
        if (!viewer.overlay || !viewer.overlay.classList.contains('is-open')) return;
        viewer.overlay.classList.remove('is-open');
        document.body.classList.remove(`${SCRIPT_NS}-viewer-lock`);
        viewer.image.src = '';
    }

    function showAt(nextIndex) {
        if (!viewer.items.length) return;
        const length = viewer.items.length;
        viewer.index = (nextIndex + length) % length;
        const item = viewer.items[viewer.index];
        resetView();
        viewer.image.src = item.url;
        viewer.image.alt = item.alt;
        viewer.counter.textContent = `${viewer.index + 1} / ${length}`;
        viewer.caption.textContent = item.alt || item.url;
    }

    function getFitScale() {
        if (!viewer.image || !viewer.stage || !viewer.image.naturalWidth || !viewer.image.naturalHeight) return 1;
        const rect = viewer.stage.getBoundingClientRect();
        return clamp(Math.min(rect.width / viewer.image.naturalWidth, rect.height / viewer.image.naturalHeight, 1), 0.08, 1);
    }

    function resetView() {
        viewer.scale = getFitScale();
        viewer.offsetX = 0;
        viewer.offsetY = 0;
        renderImage();
    }

    function setScale(scale) {
        viewer.scale = clamp(scale, 0.2, 8);
        renderImage();
    }

    function zoomBy(multiplier) {
        setScale(viewer.scale * multiplier);
    }

    function onWheel(event) {
        if (!viewer.overlay || !viewer.overlay.classList.contains('is-open')) return;
        event.preventDefault();
        zoomBy(event.deltaY > 0 ? 0.9 : 1.1);
    }

    function onDragStart(event) {
        if (event.button !== 0) return;
        viewer.dragging = true;
        viewer.startX = event.clientX;
        viewer.startY = event.clientY;
        viewer.baseX = viewer.offsetX;
        viewer.baseY = viewer.offsetY;
        viewer.image.classList.add('is-dragging');
    }

    function onDragMove(event) {
        if (!viewer.dragging) return;
        viewer.offsetX = viewer.baseX + event.clientX - viewer.startX;
        viewer.offsetY = viewer.baseY + event.clientY - viewer.startY;
        renderImage();
    }

    function onDragEnd() {
        viewer.dragging = false;
        if (viewer.image) viewer.image.classList.remove('is-dragging');
    }

    function onKeyDown(event) {
        if (!viewer.overlay || !viewer.overlay.classList.contains('is-open')) return;
        if (event.key === 'Escape') closeViewer();
        if (event.key === 'ArrowLeft') showAt(viewer.index - 1);
        if (event.key === 'ArrowRight') showAt(viewer.index + 1);
        if (event.key === '+' || event.key === '=') zoomBy(1.18);
        if (event.key === '-') zoomBy(0.85);
        if (event.key === '0') resetView();
    }

    function renderImage() {
        if (!viewer.image) return;
        viewer.image.style.transform = `translate(calc(-50% + ${viewer.offsetX}px), calc(-50% + ${viewer.offsetY}px)) scale(${viewer.scale})`;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function markImages(root = document) {
        qsa(VIEWABLE_SELECTORS.join(','), root).forEach(img => {
            if (isViewableImage(img)) img.classList.add(`${SCRIPT_NS}-image-enabled`);
        });
    }

    function onDocumentClick(event) {
        const target = event.target;
        if (!target || target.tagName !== 'IMG' || !isViewableImage(target)) return;
        event.preventDefault();
        event.stopPropagation();
        openViewer(target);
    }

    function escapeMarkdownText(text) {
        return String(text || '').replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    }

    function escapeMarkdownUrl(url) {
        return String(url || '').replace(/\)/g, '%29').replace(/\s/g, '%20');
    }

    function getHeadingLevel(item) {
        for (const [className, level] of HEADING_LEVELS) {
            if (hasClass(item, className)) return level;
        }
        return 0;
    }

    function renderInlineNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.nodeValue || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const element = node;
        let content = Array.from(element.childNodes).map(renderInlineNode).join('');
        if (!content && element.tagName === 'IMG') return renderImageElement(element);
        if (element.tagName === 'A') {
            const href = element.href || element.getAttribute('href') || '';
            return href ? `[${content}](${escapeMarkdownUrl(href)})` : content;
        }
        if (hasClass(element, 'bold')) content = `**${content}**`;
        if (hasClass(element, 'underline')) content = `<u>${content}</u>`;
        return content;
    }

    function renderInlineContainer(container) {
        return Array.from(container.childNodes).map(renderInlineNode).join('').replace(/[ \t]+\n/g, '\n').trim();
    }

    function renderImageElement(img) {
        const src = normalizeImageUrl(img.currentSrc || img.src || img.getAttribute('src') || '');
        if (!src || src.startsWith('data:') || src.startsWith('blob:')) return '';
        const alt = escapeMarkdownText(img.alt || img.title || '');
        return `![${alt}](${escapeMarkdownUrl(src)})`;
    }

    function renderImages(root) {
        const images = qsa('img', root).map(renderImageElement).filter(Boolean);
        return Array.from(new Set(images)).join('\n\n');
    }

    function renderBlock(item) {
        if (!item || item.nodeType !== Node.ELEMENT_NODE) return '';
        const level = getHeadingLevel(item);
        if (level) {
            const text = renderInlineContainer(qs('.block-header', item) || item);
            return text ? `${'#'.repeat(level)} ${text}` : '';
        }
        if (qs(':scope > .callout, :scope > div.callout', item) || qs('.callout', item)) {
            const icon = textOf(qs('.emoji-text', item)) || '>';
            const content = qsa('.callout .vc-doc-item', item).map(renderBlock).filter(Boolean).join('\n\n');
            const body = content || textOf(item).replace(icon, '').trim();
            return body ? `> ${icon} ${body.replace(/\n\n/g, '\n> ')}` : `> ${icon}`;
        }
        if (qs(':scope > .grid, :scope > div.grid', item)) return renderImages(qs('.grid', item) || item);
        const orderBlock = qs('.block-order', item);
        if (orderBlock) {
            const marker = textOf(qs('.order-marker', orderBlock)).replace(/\s+/g, '') || '1.';
            const number = marker.match(/\d+/)?.[0] || '1';
            const content = renderInlineContainer(qs('.list', orderBlock) || orderBlock);
            return content ? `${number}. ${content}` : '';
        }
        const imageBlock = qs('.block-image', item);
        if (imageBlock) return renderImages(imageBlock);
        if (qs('.block-driver', item)) return '---';
        const textBlock = qs('.block-text', item);
        if (textBlock) return renderInlineContainer(textBlock);
        return textOf(item);
    }

    function compactMarkdown(markdown) {
        return String(markdown || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function getArticleMeta() {
        return {
            title: textOf(qs('.post-title.post-title--for-long-article')) || document.title || '生财有术文章',
            author: textOf(qs('.post-item-top .name')),
            date: textOf(qs('.post-item-top .date')),
            url: window.location.href,
        };
    }

    function buildMarkdownFromPage() {
        const root = qs('.feishu-doc-content');
        if (!root) throw new Error('未找到文章正文容器 .feishu-doc-content');
        const meta = getArticleMeta();
        const header = [
            `# ${meta.title}`,
            meta.author ? `作者：${meta.author}` : '',
            meta.date ? `发布时间：${meta.date}` : '',
            `原文：${meta.url}`,
        ].filter(Boolean).join('\n\n');
        const body = qsa(':scope > .vc-doc-item', root).map(renderBlock).filter(Boolean).join('\n\n');
        return compactMarkdown(`${header}\n\n${body}`);
    }

    function normalizeFileName(name) {
        return String(name || '生财有术文章').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || '生财有术文章';
    }

    function downloadText(filename, content) {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function copyTextWithTextArea(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        textarea.style.opacity = '0';
        textarea.setAttribute('readonly', 'readonly');
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } finally {
            textarea.remove();
        }
        return copied;
    }

    async function copyText(text) {
        const errors = [];
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (error) {
                errors.push(error);
            }
        }
        try {
            if (copyTextWithTextArea(text)) return;
        } catch (error) {
            errors.push(error);
        }
        if (typeof GM_setClipboard === 'function') {
            try {
                GM_setClipboard(text, 'text');
                return;
            } catch (error) {
                errors.push(error);
            }
        }
        throw new Error(`复制失败：${errors.map(error => error.message || String(error)).join('；') || '浏览器拒绝写入剪贴板'}`);
    }

    function openPreview(markdown) {
        const previewWindow = window.open('', '_blank', 'width=980,height=720');
        if (!previewWindow) throw new Error('无法打开 Markdown 预览窗口');
        previewWindow.document.title = '生财文章 Markdown 预览';
        previewWindow.document.body.innerHTML = '';
        const style = previewWindow.document.createElement('style');
        style.textContent = 'body{margin:0;padding:24px;background:#f6f7f8;color:#1f2933;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{max-width:980px;margin:0 auto;padding:20px;border:1px solid #d8dee4;border-radius:8px;background:#fff;white-space:pre-wrap;word-break:break-word;line-height:1.65;font-size:14px}';
        previewWindow.document.head.appendChild(style);
        const pre = previewWindow.document.createElement('pre');
        pre.textContent = markdown;
        previewWindow.document.body.appendChild(pre);
    }

    async function getHmacKey() {
        if (!hmacKeyPromise) {
            hmacKeyPromise = crypto.subtle.importKey('raw', encoder.encode(HMAC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        }
        return hmacKeyPromise;
    }

    function bytesToHexUpper(bytes) {
        return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function bytesToBase64Url(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function base64UrlToText(value) {
        const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function encodeUserInfo(userInfo) {
        return bytesToBase64Url(encoder.encode(String(userInfo || '').trim() || '未填写'));
    }

    async function computeSignature16(payload) {
        const key = await getHmacKey();
        const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
        return bytesToHexUpper(new Uint8Array(digest).subarray(0, 16));
    }

    function normalizeDeviceCode(raw) {
        const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!/^[A-Z0-9]{16}$/.test(cleaned)) throw new Error('设备码格式应为16位字母数字');
        return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}`;
    }

    function normalizeExpiryPart(raw) {
        const text = String(raw || '').trim().toUpperCase();
        if (text === '999' || text === 'PERM' || text === '永久') return 'PERM';
        const normalizedDate = text.replace(/[-\s]/g, '');
        if (!/^\d{8}$/.test(normalizedDate)) throw new Error('到期时间应为 YYYYMMDD、YYYY-MM-DD 或 999');
        return normalizedDate;
    }

    function isExpiryValid(expiryPart, now = new Date()) {
        if (expiryPart === 'PERM') return true;
        if (!/^\d{8}$/.test(expiryPart)) return false;
        const y = Number(expiryPart.slice(0, 4));
        const m = Number(expiryPart.slice(4, 6));
        const d = Number(expiryPart.slice(6, 8));
        const end = new Date(y, m - 1, d, 23, 59, 59, 999);
        return end.getTime() >= now.getTime();
    }

    async function buildMarkdownUnlockKey(deviceCode, userInfo, expiryPart) {
        const normalizedDevice = normalizeDeviceCode(deviceCode);
        const normalizedExpiry = normalizeExpiryPart(expiryPart);
        const userPart = encodeUserInfo(userInfo);
        const signature = await computeSignature16(`${UNLOCK_PRODUCT}|${UNLOCK_FEATURE}|${normalizedDevice}|${normalizedExpiry}|${userPart}`);
        return `${UNLOCK_PREFIX}2-${normalizedDevice}-${normalizedExpiry}-${userPart}-${signature}`;
    }

    async function verifyMarkdownUnlockKey(key, deviceCode = getDeviceCode()) {
        const input = String(key || '').trim();
        const match = input.match(/^SCYS-MD2-([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})-([A-Z0-9]{4,8})-([A-Za-z0-9_-]+)-([A-F0-9]{32})$/);
        if (!match) return false;
        const normalizedDevice = normalizeDeviceCode(deviceCode);
        const keyDevice = normalizeDeviceCode(match[1]);
        const expiryPart = normalizeExpiryPart(match[2]);
        if (keyDevice !== normalizedDevice || !isExpiryValid(expiryPart)) return false;
        const userPart = match[3];
        const signature = await computeSignature16(`${UNLOCK_PRODUCT}|${UNLOCK_FEATURE}|${keyDevice}|${expiryPart}|${userPart}`);
        return input === `${UNLOCK_PREFIX}2-${keyDevice}-${expiryPart}-${userPart}-${signature}`;
    }

    function createRandomDeviceCode() {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(16);
        if (crypto && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        let raw = '';
        for (const byte of bytes) raw += alphabet[byte % alphabet.length];
        return normalizeDeviceCode(raw);
    }

    function getDeviceCode() {
        try {
            const stored = typeof GM_getValue === 'function' ? GM_getValue(DEVICE_STORAGE_KEY, '') : '';
            if (stored) return normalizeDeviceCode(stored);
        } catch (error) {
            // Regenerate below when stored data is malformed.
        }
        const code = createRandomDeviceCode();
        if (typeof GM_setValue === 'function') GM_setValue(DEVICE_STORAGE_KEY, code);
        return code;
    }

    function getStoredUnlockKey() {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(UNLOCK_STORAGE_KEY, '');
        } catch (error) {
            return '';
        }
        return '';
    }

    function setStoredUnlockKey(key) {
        if (typeof GM_setValue === 'function') GM_setValue(UNLOCK_STORAGE_KEY, key);
    }

    function isMarkdownBarEnabled() {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(MD_BAR_VISIBLE_STORAGE_KEY, true) !== false;
        } catch (error) {
            return true;
        }
        return true;
    }

    function setMarkdownBarEnabled(enabled) {
        if (typeof GM_setValue === 'function') GM_setValue(MD_BAR_VISIBLE_STORAGE_KEY, Boolean(enabled));
    }

    async function ensureMarkdownUnlocked() {
        const stored = getStoredUnlockKey();
        if (stored && await verifyMarkdownUnlockKey(stored)) return true;
        const input = qs(`.${SCRIPT_NS}-advanced-key`);
        const value = input ? input.value : '';
        if (!value) return false;
        const ok = await verifyMarkdownUnlockKey(value, getDeviceCode());
        if (ok) {
            setStoredUnlockKey(value.trim());
            await refreshMarkdownBar();
            closeAdvancedPanel();
            notify('高级功能已解锁');
        } else {
            notify('密钥无效', 'error');
        }
        return ok;
    }

    async function runMarkdownAction(action) {
        if (!await ensureMarkdownUnlocked()) return;
        try {
            const markdown = buildMarkdownFromPage();
            const meta = getArticleMeta();
            if (action === 'view') openPreview(markdown);
            if (action === 'copy') {
                await copyText(markdown);
                notify('Markdown 已复制');
            }
            if (action === 'download') {
                downloadText(`${normalizeFileName(meta.title)}.md`, markdown);
                notify('Markdown 已开始下载');
            }
        } catch (error) {
            console.error(error);
            notify(error.message || 'Markdown 操作失败', 'error');
        }
    }

    function notify(message, type = 'info') {
        let box = qs(`.${SCRIPT_NS}-toast`);
        if (!box) {
            box = document.createElement('div');
            box.className = `${SCRIPT_NS}-toast`;
            document.body.appendChild(box);
        }
        box.textContent = message;
        box.dataset.type = type;
        box.classList.add('is-visible');
        window.clearTimeout(notify.timer);
        notify.timer = window.setTimeout(() => box.classList.remove('is-visible'), 2200);
    }

    function createMarkdownFloatingBar() {
        if (qs(`.${SCRIPT_NS}-mdbar`)) return;
        const bar = document.createElement('div');
        bar.className = `${SCRIPT_NS}-mdbar`;
        bar.appendChild(createButton('查看MD', '查看 Markdown', () => runMarkdownAction('view')));
        bar.appendChild(createButton('复制MD', '复制 Markdown', () => runMarkdownAction('copy')));
        bar.appendChild(createButton('下载MD', '下载 Markdown', () => runMarkdownAction('download')));
        document.body.appendChild(bar);
    }

    async function refreshMarkdownBar() {
        createMarkdownFloatingBar();
        const bar = qs(`.${SCRIPT_NS}-mdbar`);
        if (!bar) return;
        const stored = getStoredUnlockKey();
        const visible = Boolean(isMarkdownBarEnabled() && stored && await verifyMarkdownUnlockKey(stored));
        bar.classList.toggle('is-visible', visible);
    }

    function closeAdvancedPanel() {
        const mask = qs(`.${SCRIPT_NS}-advanced-mask`);
        if (mask) mask.classList.remove('is-visible');
    }

    function createAdvancedPanel() {
        let mask = qs(`.${SCRIPT_NS}-advanced-mask`);
        if (mask) return mask;
        mask = document.createElement('div');
        mask.className = `${SCRIPT_NS}-advanced-mask`;
        mask.innerHTML = `
            <div class="${SCRIPT_NS}-advanced-panel" role="dialog" aria-modal="true">
                <h3>高级功能</h3>
                <p>请把随机设备码发给料主（liaozhu913）获取解锁密钥。解锁成功后，页面右下角会显示 Markdown 私用功能按钮。</p>
                <label>随机设备码</label>
                <div class="${SCRIPT_NS}-advanced-row">
                    <input class="${SCRIPT_NS}-advanced-device" readonly />
                    <button type="button" class="${SCRIPT_NS}-copy-device">复制设备码</button>
                </div>
                <label>解锁密钥</label>
                <input class="${SCRIPT_NS}-advanced-key" placeholder="粘贴料主提供的解锁密钥" />
                <label class="${SCRIPT_NS}-advanced-toggle">
                    <input class="${SCRIPT_NS}-mdbar-toggle" type="checkbox" />
                    显示 Markdown 浮窗按钮
                </label>
                <div class="${SCRIPT_NS}-advanced-actions">
                    <button type="button" class="${SCRIPT_NS}-advanced-close">关闭</button>
                    <button type="button" class="${SCRIPT_NS}-advanced-unlock" data-primary="true">解锁</button>
                </div>
            </div>
        `;
        mask.addEventListener('click', event => {
            if (event.target === mask || event.target.closest(`.${SCRIPT_NS}-advanced-close`)) closeAdvancedPanel();
        });
        qs(`.${SCRIPT_NS}-copy-device`, mask).addEventListener('click', async () => {
            try {
                await copyText(getDeviceCode());
                notify('设备码已复制');
            } catch (error) {
                notify(error.message || '复制设备码失败', 'error');
            }
        });
        qs(`.${SCRIPT_NS}-advanced-unlock`, mask).addEventListener('click', () => ensureMarkdownUnlocked());
        qs(`.${SCRIPT_NS}-mdbar-toggle`, mask).addEventListener('change', async event => {
            setMarkdownBarEnabled(event.target.checked);
            await refreshMarkdownBar();
            notify(event.target.checked ? 'Markdown 浮窗按钮已显示' : 'Markdown 浮窗按钮已隐藏');
        });
        document.body.appendChild(mask);
        return mask;
    }

    async function openAdvancedFeature() {
        const mask = createAdvancedPanel();
        qs(`.${SCRIPT_NS}-advanced-device`, mask).value = getDeviceCode();
        qs(`.${SCRIPT_NS}-advanced-key`, mask).value = '';
        qs(`.${SCRIPT_NS}-mdbar-toggle`, mask).checked = isMarkdownBarEnabled();
        mask.classList.add('is-visible');
        qs(`.${SCRIPT_NS}-advanced-key`, mask).focus();
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('高级功能', () => openAdvancedFeature());
    }

    function initImageEnhancement() {
        addStyles();
        markImages();
        document.addEventListener('click', onDocumentClick, true);
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) markImages(node);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (window.__SCYS_OFFICIAL_ASSISTANT_TEST__) {
        window.__SCYSOfficialAssistantTest = {
            normalizeImageUrl,
            isViewableImage,
            verifyMarkdownUnlockKey,
            buildMarkdownUnlockKey,
            buildMarkdownFromPage,
            copyText,
            getDeviceCode,
            openAdvancedFeature,
            isMarkdownBarEnabled,
            setMarkdownBarEnabled,
        };
        return;
    }

    initImageEnhancement();
    registerMenus();
    refreshMarkdownBar();
})();
