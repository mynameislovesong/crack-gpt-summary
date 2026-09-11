// ==UserScript==
// @name         Crack GPT 로그 요약 (Tampermonkey)
// @namespace    https://github.com/mynameislovesong/crack-gpt-summary
// @version      1.2.14.1
// @description  Crack RP 로그를 수집해 지정한 ChatGPT 채팅으로 TXT 첨부·전송합니다. Chrome 확장 v1.2.14의 Tampermonkey 포트입니다.
// @author       mynameislovesong
// @homepageURL  https://github.com/mynameislovesong/crack-gpt-summary
// @supportURL   https://github.com/mynameislovesong/crack-gpt-summary/issues
// @updateURL    https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/crack-gpt-summary.user.js
// @downloadURL  https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/crack-gpt-summary.user.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/shim.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/core.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/crack-route-api.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/crack-settings.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/crack-background.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/crack-ui.js
// @require      https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/dist/chatgpt.js
// @match        https://crack.wrtn.ai/*
// @match        https://chatgpt.com/*
// @connect      crack-api.wrtn.ai
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Implementation is loaded through @require from this repository.
