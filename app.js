/* =========================================================
   Bột iuu thi tốt — VNR202 Quizlet-style Study Engine
   Full localStorage persistence: progress, favorites,
   60-question random exams, exam history, right/wrong stats,
   and 100% question-linked study tips.
   ========================================================= */

(function () {
  'use strict';

  const STORAGE_KEY = 'vnr202_bot_iuu_v1';
  const { questions: QUESTIONS, tips: TIPS } = window.VNR_DATA;

  // Fast lookups
  const Q_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
  const TIP_BY_ID = new Map(TIPS.map((t) => [t.id, t]));
  const Q_TO_TIPS = new Map();
  QUESTIONS.forEach((q) => Q_TO_TIPS.set(q.id, []));
  TIPS.forEach((tip) => {
    tip.questionIds.forEach((qid) => {
      if (Q_TO_TIPS.has(qid)) Q_TO_TIPS.get(qid).push(tip);
    });
  });

  // ==================== PERSISTENT STATE ====================
  function defaultState() {
    return {
      progress: {},     // { [qid]: 'mastered' | 'learning' }
      favorites: {},    // { [qid]: true }
      stats: {},        // { [qid]: { right: 0, wrong: 0, lastResult: 'right'|'wrong', lastAt: ms } }
      examHistory: [],  // [{ id, startedAt, finishedAt, durationSec, total, correct, scoreTen, sourceLabel, items }]
      activeExam: null, // saved in-progress exam
      prefs: {
        fcFilter: 'all',
        fcIndex: 0,
        fcHighlight: true,
        learnFilter: 'smart',
        learnShuffleOpt: true,
        learnHighlight: true,
        bankShowAns: true,
        bankHighlight: true
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        prefs: { ...defaultState().prefs, ...(parsed.prefs || {}) }
      };
    } catch (e) {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save state to localStorage:', e);
    }
    updateHeaderStats();
  }

  // ==================== RUNTIME UI STATE ====================
  let currentTab = 'flashcards';

  // Flashcards
  let fcDeck = [];
  let fcIdx = 0;
  let fcCustomSet = null; // { title, ids }

  // Learn Mode
  let learnDeck = [];
  let learnIdx = 0;
  let learnCustomSet = null; // { title, ids }
  let learnSessionRight = 0;
  let learnSessionWrong = 0;
  let learnCurrentAnswered = false;
  let learnSelectedKeys = new Set();
  let learnCurrentOptionOrder = [];

  // Exam Mode
  let examTimerInterval = null;
  let viewingResultAttempt = null;
  let resFilter = 'all';

  // Tips / History / Bank
  let tipsGroup = 'all';
  let historySubView = 'attempts';
  let statsFilter = 'wrong';
  let bankFilter = 'all';

  // Quick-view modal
  let qmCurrentId = null;
  let qmShowAns = true;

  // ==================== HELPERS ====================
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeVN(str) {
    return String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
  }

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderHighlightedText(text, highlights, enabled) {
    let html = escapeHtml(text);
    if (!enabled || !highlights || !highlights.length) return html;
    // Sort longest first to avoid nested replacement
    const sorted = [...highlights].sort((a, b) => b.length - a.length);
    for (const h of sorted) {
      if (!h || h.length < 2) continue;
      const esc = escapeHtml(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(esc, 'i'), (m) => `<mark class="kw-hl">${m}</mark>`);
    }
    return html;
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function formatDateTime(ms) {
    const d = new Date(ms);
    return d.toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }

  function arraysEqualSet(a, b) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function isFav(qid) {
    return !!state.favorites[qid];
  }

  function toggleFavorite(qid) {
    if (state.favorites[qid]) {
      delete state.favorites[qid];
      showToast(`Đã bỏ thả tim Câu ${qid}`);
    } else {
      state.favorites[qid] = true;
      showToast(`❤️ Đã lưu Câu ${qid} vào mục Yêu thích!`);
    }
    saveState();
    return isFav(qid);
  }

  function setHeartUI(btn, fav) {
    btn.textContent = fav ? '❤️' : '🤍';
    btn.classList.toggle('active', fav);
  }

  function recordAnswerStat(qid, isRight) {
    if (!state.stats[qid]) state.stats[qid] = { right: 0, wrong: 0, lastResult: null, lastAt: 0 };
    if (isRight) {
      state.stats[qid].right += 1;
      state.stats[qid].lastResult = 'right';
    } else {
      state.stats[qid].wrong += 1;
      state.stats[qid].lastResult = 'wrong';
    }
    state.stats[qid].lastAt = Date.now();
  }

  function getStatusLabel(qid) {
    const st = state.progress[qid];
    if (st === 'mastered') return { text: '✓ Đã thuộc', cls: 'is-mastered' };
    if (st === 'learning') return { text: '🔁 Cần ôn lại', cls: 'is-learning' };
    return { text: '○ Chưa học', cls: '' };
  }

  function hasBeenWrong(qid) {
    return (state.stats[qid]?.wrong || 0) > 0;
  }

  function updateHeaderStats() {
    const masteredCount = QUESTIONS.filter((q) => state.progress[q.id] === 'mastered').length;
    const favCount = QUESTIONS.filter((q) => state.favorites[q.id]).length;
    $('hdrMastered').textContent = masteredCount;
    $('hdrTotal').textContent = QUESTIONS.length;
    $('hdrFavorites').textContent = favCount;
    $('globalProgressFill').style.width = `${(masteredCount / QUESTIONS.length) * 100}%`;
    updateFlashcardCounts();
    const bfc = $('bankFavCount');
    if (bfc) bfc.textContent = favCount;
  }

  function buildTipPillsHtml(qid) {
    const tips = Q_TO_TIPS.get(qid) || [];
    if (!tips.length) return '';
    return tips
      .map((t) => `<button type="button" class="tip-pill" data-jump-tip="${t.id}" title="Xem mẹo học này">${t.icon} Mẹo: ${escapeHtml(t.title)}</button>`)
      .join('');
  }

  // ==================== NAVIGATION ====================
  function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${tabName}`);
    });

    if (tabName === 'flashcards') renderFlashcard();
    else if (tabName === 'learn') {
      if (!learnDeck.length) buildLearnDeck();
      renderLearnQuestion();
    } else if (tabName === 'exam') renderExamTabState();
    else if (tabName === 'tips') renderTips();
    else if (tabName === 'history') renderHistoryTab();
    else if (tabName === 'bank') renderBank();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function jumpToTip(tipId) {
    tipsGroup = 'all';
    $('tipsSearchInput').value = '';
    document.querySelectorAll('#tipsGroupChips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.group === 'all');
    });
    switchTab('tips');
    setTimeout(() => {
      const card = document.querySelector(`[data-tip-card="${tipId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('tip-pulse');
        setTimeout(() => card.classList.remove('tip-pulse'), 1800);
      }
    }, 80);
  }

  // Delegate tip-pill clicks anywhere
  document.addEventListener('click', (e) => {
    const tipBtn = e.target.closest('[data-jump-tip]');
    if (tipBtn) {
      e.stopPropagation();
      closeQuestionModal();
      jumpToTip(tipBtn.dataset.jumpTip);
      return;
    }
    const qLink = e.target.closest('[data-open-q]');
    if (qLink) {
      e.stopPropagation();
      openQuestionModal(qLink.dataset.openQ);
    }
  });

  // ==================== TAB 1: FLASHCARDS ====================
  function updateFlashcardCounts() {
    const counts = {
      all: QUESTIONS.length,
      unseen: 0,
      learning: 0,
      mastered: 0,
      favorite: 0,
      wrong: 0
    };
    QUESTIONS.forEach((q) => {
      const st = state.progress[q.id];
      if (!st) counts.unseen++;
      else if (st === 'learning') counts.learning++;
      else if (st === 'mastered') counts.mastered++;
      if (state.favorites[q.id]) counts.favorite++;
      if (hasBeenWrong(q.id)) counts.wrong++;
    });
    document.querySelectorAll('#fcFilters [data-count]').forEach((el) => {
      el.textContent = counts[el.dataset.count] ?? 0;
    });
  }

  function getFilteredIds(filter) {
    if (filter === 'all') return QUESTIONS.map((q) => q.id);
    if (filter === 'unseen') return QUESTIONS.filter((q) => !state.progress[q.id]).map((q) => q.id);
    if (filter === 'learning') return QUESTIONS.filter((q) => state.progress[q.id] === 'learning').map((q) => q.id);
    if (filter === 'mastered') return QUESTIONS.filter((q) => state.progress[q.id] === 'mastered').map((q) => q.id);
    if (filter === 'favorite') return QUESTIONS.filter((q) => state.favorites[q.id]).map((q) => q.id);
    if (filter === 'wrong') return QUESTIONS.filter((q) => hasBeenWrong(q.id)).map((q) => q.id);
    return QUESTIONS.map((q) => q.id);
  }

  function rebuildFlashcardDeck(keepIndex = false) {
    if (fcCustomSet) {
      fcDeck = fcCustomSet.ids.filter((id) => Q_BY_ID.has(id));
      $('fcCustomBanner').classList.remove('hidden');
      $('fcCustomBannerText').textContent = `✨ Đang lật thẻ bộ riêng: ${fcCustomSet.title} (${fcDeck.length} câu)`;
    } else {
      $('fcCustomBanner').classList.add('hidden');
      fcDeck = getFilteredIds(state.prefs.fcFilter);
    }
    if (!keepIndex) {
      fcIdx = (!fcCustomSet && state.prefs.fcFilter === 'all') ? Math.min(state.prefs.fcIndex || 0, Math.max(0, fcDeck.length - 1)) : 0;
    } else {
      fcIdx = Math.min(fcIdx, Math.max(0, fcDeck.length - 1));
    }
    renderFlashcard();
  }

  function renderFlashcard() {
    $('fcHighlightToggle').checked = !!state.prefs.fcHighlight;
    document.querySelectorAll('#fcFilters .chip').forEach((c) => {
      c.classList.toggle('active', !fcCustomSet && c.dataset.filter === state.prefs.fcFilter);
    });

    if (!fcDeck.length) {
      $('fcStage').classList.add('hidden');
      $('fcEmptyState').classList.remove('hidden');
      return;
    }

    $('fcStage').classList.remove('hidden');
    $('fcEmptyState').classList.add('hidden');

    const q = Q_BY_ID.get(fcDeck[fcIdx]);
    const hlOn = !!state.prefs.fcHighlight;

    $('fcCard').classList.remove('is-flipped');
    $('fcCounter').textContent = `Thẻ ${fcIdx + 1} / ${fcDeck.length}`;
    $('fcFrontTag').textContent = `Câu ${q.id}${q.answer.length > 1 ? ' • Chọn nhiều đáp án' : ''}`;
    $('fcBackTag').textContent = `Đáp án đúng • Câu ${q.id}`;

    const st = getStatusLabel(q.id);
    const sb = $('fcStatusBadge');
    sb.textContent = st.text;
    sb.className = `status-badge ${st.cls}`;
    setHeartUI($('fcHeartBtn'), isFav(q.id));

    $('fcQuestion').innerHTML = renderHighlightedText(q.question, q.qHighlight, hlOn);
    $('fcOptionsFront').innerHTML = q.options
      .map((o) => `<li><strong>${o.key}.</strong> ${escapeHtml(o.text)}</li>`)
      .join('');

    const ansObjs = q.options.filter((o) => q.answer.includes(o.key));
    $('fcAnswerBox').innerHTML = ansObjs
      .map(
        (o) => `<div class="fc-ans-item"><span class="fc-ans-label">${o.key}</span>${renderHighlightedText(o.text, o.hl, hlOn)}</div>`
      )
      .join('');

    const noteEl = $('fcNoteBox');
    if (q.note) {
      noteEl.textContent = `💡 Ghi chú: ${q.note}`;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }

    const tipsHtml = buildTipPillsHtml(q.id);
    $('fcTipsFront').innerHTML = tipsHtml;
    $('fcTipsBack').innerHTML = tipsHtml;

    $('fcPrevBtn').disabled = fcIdx === 0;
    $('fcNextBtn').disabled = fcIdx === fcDeck.length - 1;

    if (!fcCustomSet && state.prefs.fcFilter === 'all') {
      state.prefs.fcIndex = fcIdx;
      saveState();
    }
  }

  function rateFlashcard(status) {
    if (!fcDeck.length) return;
    const qid = fcDeck[fcIdx];
    state.progress[qid] = status;
    saveState();
    showToast(status === 'mastered' ? `✓ Đã đánh dấu thuộc Câu ${qid}!` : `🔁 Đã đưa Câu ${qid} vào Cần ôn lại`);
    if (fcIdx < fcDeck.length - 1) {
      fcIdx++;
      renderFlashcard();
    } else {
      renderFlashcard();
    }
  }

  function openCustomFlashcards(title, ids) {
    fcCustomSet = { title, ids };
    fcIdx = 0;
    rebuildFlashcardDeck(false);
    switchTab('flashcards');
  }

  function openSingleQuestionInFlashcard(qid) {
    fcCustomSet = null;
    state.prefs.fcFilter = 'all';
    fcDeck = QUESTIONS.map((q) => q.id);
    const idx = fcDeck.indexOf(qid);
    fcIdx = idx >= 0 ? idx : 0;
    state.prefs.fcIndex = fcIdx;
    saveState();
    closeQuestionModal();
    switchTab('flashcards');
  }

  // ==================== TAB 2: LEARN MODE ====================
  function buildLearnDeck() {
    if (learnCustomSet) {
      learnDeck = learnCustomSet.ids.filter((id) => Q_BY_ID.has(id));
      $('learnCustomBanner').classList.remove('hidden');
      $('learnCustomBannerText').textContent = `🧠 Đang học bộ riêng: ${learnCustomSet.title} (${learnDeck.length} câu)`;
    } else {
      $('learnCustomBanner').classList.add('hidden');
      const f = state.prefs.learnFilter || 'smart';
      if (f === 'smart') {
        // Prioritize: wrong > learning > unseen > mastered
        const wrongIds = QUESTIONS.filter((q) => hasBeenWrong(q.id) && state.progress[q.id] !== 'mastered').map((q) => q.id);
        const learningIds = QUESTIONS.filter((q) => state.progress[q.id] === 'learning' && !wrongIds.includes(q.id)).map((q) => q.id);
        const unseenIds = QUESTIONS.filter((q) => !state.progress[q.id] && !wrongIds.includes(q.id)).map((q) => q.id);
        learnDeck = [...wrongIds, ...learningIds, ...unseenIds];
      } else {
        learnDeck = getFilteredIds(f);
      }
    }
    learnIdx = 0;
    learnSessionRight = 0;
    learnSessionWrong = 0;
    renderLearnQuestion();
  }

  function renderLearnQuestion() {
    $('learnShuffleOpt').checked = !!state.prefs.learnShuffleOpt;
    $('learnHighlightToggle').checked = !!state.prefs.learnHighlight;
    document.querySelectorAll('#learnFilters .chip').forEach((c) => {
      c.classList.toggle('active', !learnCustomSet && c.dataset.filter === state.prefs.learnFilter);
    });

    if (!learnDeck.length) {
      $('learnStage').classList.add('hidden');
      $('learnEmptyState').classList.remove('hidden');
      return;
    }

    $('learnStage').classList.remove('hidden');
    $('learnEmptyState').classList.add('hidden');

    const q = Q_BY_ID.get(learnDeck[learnIdx]);
    learnCurrentAnswered = false;
    learnSelectedKeys = new Set();

    const isMulti = q.answer.length > 1;
    $('learnCounter').textContent = `Câu ${learnIdx + 1} / ${learnDeck.length}`;
    $('learnSessionScore').textContent = `Phiên này: ${learnSessionRight} đúng • ${learnSessionWrong} sai`;
    $('learnProgressBar').style.width = `${((learnIdx + 1) / learnDeck.length) * 100}%`;
    $('learnQTag').textContent = `Câu ${q.id}`;
    $('learnMultiBadge').classList.toggle('hidden', !isMulti);
    $('learnMultiBadge').textContent = `Chọn ${q.answer.length} đáp án`;

    const st = state.stats[q.id];
    $('learnHistBadge').textContent = st ? `(Lịch sử: ${st.right} đúng • ${st.wrong} sai)` : '';
    setHeartUI($('learnHeartBtn'), isFav(q.id));

    $('learnQuestion').innerHTML = renderHighlightedText(q.question, q.qHighlight, !!state.prefs.learnHighlight);

    learnCurrentOptionOrder = state.prefs.learnShuffleOpt ? shuffleArray(q.options) : q.options.slice();
    const displayLetters = ['A', 'B', 'C', 'D'];
    $('learnOptions').innerHTML = learnCurrentOptionOrder
      .map(
        (opt, i) => `
      <button type="button" class="opt-btn" data-opt-key="${opt.key}">
        <span class="opt-key">${displayLetters[i] || opt.key}</span>
        <span>${escapeHtml(opt.text)}</span>
      </button>`
      )
      .join('');

    $('learnMultiSubmitWrap').classList.toggle('hidden', !isMulti);
    $('learnMultiSubmitBtn').disabled = true;
    $('learnFeedback').classList.add('hidden');
    $('learnPrevBtn').disabled = learnIdx === 0;
    $('learnNextBtn').textContent = learnIdx === learnDeck.length - 1 ? 'Hoàn thành 🎉' : 'Câu tiếp theo →';
  }

  function evaluateLearnAnswer(q, chosenKeys) {
    learnCurrentAnswered = true;
    const isRight = arraysEqualSet(chosenKeys, q.answer);
    recordAnswerStat(q.id, isRight);

    if (isRight) {
      learnSessionRight++;
      state.progress[q.id] = 'mastered';
    } else {
      learnSessionWrong++;
      state.progress[q.id] = 'learning';
    }
    saveState();

    // Color options
    document.querySelectorAll('#learnOptions .opt-btn').forEach((btn) => {
      const k = btn.dataset.optKey;
      btn.disabled = true;
      btn.classList.remove('selected');
      if (q.answer.includes(k)) btn.classList.add('is-correct');
      else if (chosenKeys.includes(k)) btn.classList.add('is-wrong');
    });

    $('learnMultiSubmitWrap').classList.add('hidden');
    const fb = $('learnFeedback');
    fb.classList.remove('hidden', 'fb-right', 'fb-wrong');
    fb.classList.add(isRight ? 'fb-right' : 'fb-wrong');
    const displayLetters = ['A', 'B', 'C', 'D'];
    const shownCorrectLetters = learnCurrentOptionOrder
      .map((opt, i) => (q.answer.includes(opt.key) ? (displayLetters[i] || opt.key) : null))
      .filter(Boolean);
    $('learnFeedbackTitle').textContent = isRight
      ? '💖 Chính xác tuyệt đối! Bột đỉnh quá!'
      : `❌ Chưa đúng rồi! Đáp án đúng là: ${shownCorrectLetters.join(', ')}`;

    const noteEl = $('learnFeedbackNote');
    if (q.note) {
      noteEl.textContent = `💡 Ghi chú: ${q.note}`;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }
    $('learnFeedbackTips').innerHTML = buildTipPillsHtml(q.id);
    $('learnSessionScore').textContent = `Phiên này: ${learnSessionRight} đúng • ${learnSessionWrong} sai`;
  }

  function openCustomLearn(title, ids) {
    learnCustomSet = { title, ids };
    buildLearnDeck();
    switchTab('learn');
  }

  // ==================== TAB 3: EXAM 60 QUESTIONS ====================
  function renderExamTabState() {
    if (viewingResultAttempt) {
      showExamSubView('result');
      renderExamResult(viewingResultAttempt);
      return;
    }
    if (state.activeExam && state.activeExam.inView) {
      showExamSubView('active');
      renderActiveExamQuestion();
      startExamTimer();
      return;
    }
    showExamSubView('setup');
    if (state.activeExam) {
      const ex = state.activeExam;
      const done = Object.values(ex.answers).filter((a) => a && a.length > 0).length;
      $('examResumeBox').classList.remove('hidden');
      $('examResumeInfo').textContent = `${ex.sourceLabel} • Đã trả lời ${done}/${ex.questions.length} câu • Bắt đầu lúc ${formatDateTime(ex.startedAt)}`;
    } else {
      $('examResumeBox').classList.add('hidden');
    }
  }

  function showExamSubView(mode) {
    $('examSetupView').classList.toggle('hidden', mode !== 'setup');
    $('examActiveView').classList.toggle('hidden', mode !== 'active');
    $('examResultView').classList.toggle('hidden', mode !== 'result');
    if (mode !== 'active') stopExamTimer();
  }

  function startNewExam() {
    const reqCount = parseInt($('examCountSelect').value, 10) || 60;
    const source = $('examSourceSelect').value;
    const mins = parseInt($('examTimeSelect').value, 10) || 0;
    const shuffleOpts = $('examShuffleOpts').checked;

    let pool = [];
    let sourceLabel = '';
    if (source === 'random') {
      pool = shuffleArray(QUESTIONS.map((q) => q.id));
      sourceLabel = `Đề ${reqCount} câu ngẫu nhiên`;
    } else if (source === 'weak') {
      const wrong = shuffleArray(QUESTIONS.filter((q) => hasBeenWrong(q.id)).map((q) => q.id));
      const unseenOrLearn = shuffleArray(QUESTIONS.filter((q) => !wrong.includes(q.id) && state.progress[q.id] !== 'mastered').map((q) => q.id));
      const rest = shuffleArray(QUESTIONS.filter((q) => !wrong.includes(q.id) && !unseenOrLearn.includes(q.id)).map((q) => q.id));
      pool = [...wrong, ...unseenOrLearn, ...rest];
      sourceLabel = `Đề ${reqCount} câu ưu tiên yếu`;
    } else if (source === 'favorite') {
      pool = shuffleArray(QUESTIONS.filter((q) => state.favorites[q.id]).map((q) => q.id));
      sourceLabel = `Đề từ câu yêu thích ❤️`;
    } else if (source === 'wrong') {
      pool = shuffleArray(QUESTIONS.filter((q) => hasBeenWrong(q.id)).map((q) => q.id));
      sourceLabel = `Đề từ câu từng làm sai ❌`;
    }

    if (!pool.length) {
      showToast('Không có câu hỏi nào trong nguồn bạn chọn!');
      return;
    }

    const selectedIds = pool.slice(0, Math.min(reqCount, pool.length));
    const examQuestions = selectedIds.map((qid) => {
      const q = Q_BY_ID.get(qid);
      const optOrder = shuffleOpts ? shuffleArray(q.options.map((o) => o.key)) : q.options.map((o) => o.key);
      return { qid, optOrder };
    });

    viewingResultAttempt = null;
    state.activeExam = {
      id: 'exam_' + Date.now(),
      startedAt: Date.now(),
      sourceLabel: `${sourceLabel} (${examQuestions.length} câu)`,
      limitSec: mins * 60,
      elapsedSec: 0,
      currentIdx: 0,
      questions: examQuestions,
      answers: {}, // { [idx]: ['A'] }
      flags: {},   // { [idx]: true }
      inView: true
    };
    saveState();
    showExamSubView('active');
    renderActiveExamQuestion();
    startExamTimer();
    showToast(`🚀 Đã tạo đề ${examQuestions.length} câu! Chúc Bột làm bài thật tốt!`);
  }

  function startExamTimer() {
    stopExamTimer();
    updateExamTimerDisplay();
    examTimerInterval = setInterval(() => {
      if (!state.activeExam || !state.activeExam.inView) {
        stopExamTimer();
        return;
      }
      state.activeExam.elapsedSec += 1;
      updateExamTimerDisplay();
      if (state.activeExam.elapsedSec % 5 === 0) saveState();
      if (state.activeExam.limitSec > 0 && state.activeExam.elapsedSec >= state.activeExam.limitSec) {
        stopExamTimer();
        showToast('⏰ Hết giờ làm bài! Hệ thống tự động nộp bài.');
        submitActiveExam(true);
      }
    }, 1000);
  }

  function stopExamTimer() {
    if (examTimerInterval) {
      clearInterval(examTimerInterval);
      examTimerInterval = null;
    }
  }

  function updateExamTimerDisplay() {
    const ex = state.activeExam;
    if (!ex) return;
    const el = $('examTimer');
    if (ex.limitSec > 0) {
      const rem = Math.max(0, ex.limitSec - ex.elapsedSec);
      el.textContent = `⏱ ${formatDuration(rem)}`;
      el.classList.toggle('timer-low', rem <= 300);
    } else {
      el.textContent = `⏱ ${formatDuration(ex.elapsedSec)}`;
      el.classList.remove('timer-low');
    }
  }

  function renderActiveExamQuestion() {
    const ex = state.activeExam;
    if (!ex) return;
    const item = ex.questions[ex.currentIdx];
    const q = Q_BY_ID.get(item.qid);
    const chosen = ex.answers[ex.currentIdx] || [];
    const isMulti = q.answer.length > 1;

    $('examCurrentPos').textContent = `Câu ${ex.currentIdx + 1} / ${ex.questions.length}`;
    $('examOriginId').textContent = `(Ngân hàng: Câu #${q.id})`;
    $('examMultiBadge').classList.toggle('hidden', !isMulti);
    $('examMultiBadge').textContent = `Chọn ${q.answer.length} đáp án`;

    const flagBtn = $('examFlagBtn');
    const isFlagged = !!ex.flags[ex.currentIdx];
    flagBtn.textContent = isFlagged ? '🚩 Đã đánh dấu' : '🚩 Xem lại';
    flagBtn.classList.toggle('btn-warn', isFlagged);
    flagBtn.classList.toggle('btn-soft', !isFlagged);

    setHeartUI($('examHeartBtn'), isFav(q.id));
    $('examQuestionText').textContent = q.question;

    const displayLetters = ['A', 'B', 'C', 'D'];
    $('examOptionsList').innerHTML = item.optOrder
      .map((origKey, i) => {
        const opt = q.options.find((o) => o.key === origKey);
        const sel = chosen.includes(origKey) ? 'selected' : '';
        return `
          <button type="button" class="opt-btn ${sel}" data-exam-key="${origKey}">
            <span class="opt-key">${displayLetters[i] || origKey}</span>
            <span>${escapeHtml(opt.text)}</span>
          </button>`;
      })
      .join('');

    $('examPrevBtn').disabled = ex.currentIdx === 0;
    $('examNextBtn').disabled = ex.currentIdx === ex.questions.length - 1;

    // Render sidebar grid
    const answeredCount = ex.questions.filter((_, i) => (ex.answers[i] || []).length > 0).length;
    $('examAnsweredCount').textContent = `${answeredCount}/${ex.questions.length} đã chọn`;

    $('examNavGrid').innerHTML = ex.questions
      .map((_, i) => {
        const cls = ['exam-cell'];
        if ((ex.answers[i] || []).length > 0) cls.push('answered');
        if (ex.flags[i]) cls.push('flagged');
        if (i === ex.currentIdx) cls.push('current');
        return `<button type="button" class="${cls.join(' ')}" data-exam-goto="${i}">${i + 1}</button>`;
      })
      .join('');
  }

  function submitActiveExam(force = false) {
    const ex = state.activeExam;
    if (!ex) return;
    const answeredCount = ex.questions.filter((_, i) => (ex.answers[i] || []).length > 0).length;
    const unanswered = ex.questions.length - answeredCount;
    if (!force && unanswered > 0) {
      const ok = confirm(`Bột còn ${unanswered} câu chưa chọn đáp án. Bột chắc chắn muốn nộp bài ngay chứ?`);
      if (!ok) return;
    }

    stopExamTimer();
    let correct = 0;
    const items = ex.questions.map((eq, idx) => {
      const q = Q_BY_ID.get(eq.qid);
      const chosen = ex.answers[idx] || [];
      const isRight = arraysEqualSet(chosen, q.answer);
      if (isRight) correct++;
      recordAnswerStat(q.id, isRight);
      if (isRight && !state.progress[q.id]) state.progress[q.id] = 'mastered';
      if (!isRight) state.progress[q.id] = 'learning';
      return {
        qid: q.id,
        chosen,
        correct: q.answer,
        isRight
      };
    });

    const total = items.length;
    const scoreTen = Number(((correct / total) * 10).toFixed(2));
    const attempt = {
      id: ex.id,
      startedAt: ex.startedAt,
      finishedAt: Date.now(),
      durationSec: ex.elapsedSec,
      total,
      correct,
      scoreTen,
      sourceLabel: ex.sourceLabel,
      items
    };

    state.examHistory.unshift(attempt);
    state.activeExam = null;
    saveState();

    viewingResultAttempt = attempt;
    resFilter = 'all';
    showExamSubView('result');
    renderExamResult(attempt);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderExamResult(attempt) {
    const wrong = attempt.total - attempt.correct;
    $('resScoreTen').textContent = attempt.scoreTen.toFixed(1);
    $('resRight').textContent = attempt.correct;
    $('resWrong').textContent = wrong;
    $('resDuration').textContent = formatDuration(attempt.durationSec);

    let msg = 'Cố lên Bột ơi, ôn thêm chút nữa là lên 9–10 ngay! 💪';
    if (attempt.scoreTen >= 9) msg = 'Xuất sắc quá Bột ơiii! Chuẩn bị đi nhận A+ thôi! 🏆💖';
    else if (attempt.scoreTen >= 8) msg = 'Giỏi quá trời luôn! Xem lại vài câu sai là hoàn hảo! 🌸';
    else if (attempt.scoreTen >= 6.5) msg = 'Khá ổn rồi nè! Tập trung ôn các câu sai bên dưới nhé! ✨';

    $('resTitle').textContent = `${attempt.sourceLabel} — ${attempt.correct}/${attempt.total} câu đúng`;
    $('resSubtitle').textContent = `${msg} • Làm lúc ${formatDateTime(attempt.finishedAt)}`;

    const wrongIds = attempt.items.filter((it) => !it.isRight).map((it) => it.qid);
    $('resPracticeWrongBtn').disabled = wrongIds.length === 0;
    $('resPracticeWrongBtn').textContent = wrongIds.length ? `🔁 Ôn lại ${wrongIds.length} câu sai` : '🎉 Không có câu nào sai!';

    document.querySelectorAll('#resFilterChips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.filter === resFilter);
    });

    const filtered = attempt.items.filter((it) => {
      if (resFilter === 'wrong') return !it.isRight;
      if (resFilter === 'right') return it.isRight;
      if (resFilter === 'favorite') return isFav(it.qid);
      return true;
    });

    if (!filtered.length) {
      $('resReviewList').innerHTML = `<div class="empty-state"><div class="empty-emoji">🌸</div><h3>Không có câu hỏi nào khớp bộ lọc này</h3></div>`;
      return;
    }

    $('resReviewList').innerHTML = filtered
      .map((it) => {
        const origPos = attempt.items.indexOf(it) + 1;
        const q = Q_BY_ID.get(it.qid);
        const fav = isFav(q.id);
        const chosenStr = it.chosen.length ? it.chosen.join(', ') : 'Bỏ trống';
        return `
        <div class="review-item ${it.isRight ? 'rev-right' : 'rev-wrong'}">
          <div class="rev-head">
            <div class="rev-head-left">
              <span class="q-tag">Đề câu ${origPos} • Mã #${q.id}</span>
              <span class="${it.isRight ? 'rev-badge-ok' : 'rev-badge-err'}">${it.isRight ? '✓ Đúng' : `✕ Sai (Bạn chọn: ${chosenStr} • Đúng: ${it.correct.join(', ')})`}</span>
            </div>
            <button type="button" class="heart-btn ${fav ? 'active' : ''}" data-heart-qid="${q.id}" title="Thả tim lưu câu hỏi">${fav ? '❤️' : '🤍'}</button>
          </div>
          <div class="rev-q">${escapeHtml(q.question)}</div>
          <div class="rev-opts">
            ${q.options
              .map((o) => {
                let cls = 'rev-opt';
                let mark = '';
                if (it.correct.includes(o.key)) {
                  cls += ' opt-right';
                  mark = ' ✓';
                } else if (it.chosen.includes(o.key)) {
                  cls += ' opt-user-wrong';
                  mark = ' ✕ (Bạn chọn)';
                }
                return `<div class="${cls}"><strong>${o.key}.</strong> ${escapeHtml(o.text)}${mark}</div>`;
              })
              .join('')}
          </div>
          ${q.note ? `<div class="fc-note-box" style="margin-top:10px;">💡 Ghi chú: ${escapeHtml(q.note)}</div>` : ''}
          <div class="fc-tips-inline" style="padding-top:10px;">${buildTipPillsHtml(q.id)}</div>
        </div>`;
      })
      .join('');
  }

  // ==================== TAB 4: STUDY TIPS ====================
  function renderTips() {
    const query = normalizeVN($('tipsSearchInput').value.trim());
    const filtered = TIPS.filter((t) => {
      if (tipsGroup !== 'all' && t.group !== tipsGroup) return false;
      if (!query) return true;
      const hay = normalizeVN(`${t.title} ${t.summary} ${t.bullets.join(' ')} ${t.questionIds.join(' ')}`);
      return hay.includes(query);
    });

    if (!filtered.length) {
      $('tipsGrid').innerHTML = `<div class="empty-state"><div class="empty-emoji">🔍</div><h3>Không tìm thấy mẹo học phù hợp</h3><p>Thử tìm từ khóa ngắn hơn như "Đại hội", "1941", "Nava", "WTO"...</p></div>`;
      return;
    }

    $('tipsGrid').innerHTML = filtered
      .map((tip) => {
        const qLinks = tip.questionIds
          .map((qid) => {
            let cls = 'q-link-chip';
            if (hasBeenWrong(qid) && state.progress[qid] !== 'mastered') cls += ' ql-wrong';
            else if (state.progress[qid] === 'mastered') cls += ' ql-mastered';
            const heart = isFav(qid) ? '❤️' : '';
            return `<button type="button" class="${cls}" data-open-q="${qid}" title="Xem Câu ${qid}">Câu ${qid}${heart}</button>`;
          })
          .join('');

        return `
        <article class="tip-card" data-tip-card="${tip.id}">
          <div class="tip-card-head">
            <div class="tip-title-wrap">
              <span class="tip-icon">${tip.icon}</span>
              <div>
                <span class="tip-group-badge">${escapeHtml(tip.group)} • ${tip.questionIds.length} câu áp dụng</span>
                <h3>${escapeHtml(tip.title)}</h3>
              </div>
            </div>
            <div class="tip-actions">
              <button type="button" class="btn btn-soft btn-xs" data-tip-fc="${tip.id}">🗂️ Lật thẻ (${tip.questionIds.length})</button>
              <button type="button" class="btn btn-primary btn-xs" data-tip-learn="${tip.id}">🧠 Học ngay</button>
            </div>
          </div>
          <p class="tip-summary">${escapeHtml(tip.summary)}</p>
          <ul class="tip-bullets">
            ${tip.bullets.map((b) => `<li>${b}</li>`).join('')}
          </ul>
          <div class="tip-links-box">
            <div class="tip-links-label">🔗 Áp dụng cho ${tip.questionIds.length} câu hỏi (bấm vào câu để xem chi tiết):</div>
            <div class="q-link-list">${qLinks}</div>
          </div>
        </article>`;
      })
      .join('');
  }

  // ==================== TAB 5: HISTORY & WRONG STATS ====================
  function renderHistoryTab() {
    const history = state.examHistory || [];
    const totalExams = history.length;
    const avg = totalExams ? history.reduce((s, a) => s + a.scoreTen, 0) / totalExams : 0;
    const best = totalExams ? Math.max(...history.map((a) => a.scoreTen)) : 0;
    const wrongUnique = QUESTIONS.filter((q) => hasBeenWrong(q.id)).length;

    $('statTotalExams').textContent = totalExams;
    $('statAvgScore').textContent = avg.toFixed(1);
    $('statBestScore').textContent = best.toFixed(1);
    $('statWrongUnique').textContent = wrongUnique;

    $('historyAttemptsView').classList.toggle('hidden', historySubView !== 'attempts');
    $('historyWrongView').classList.toggle('hidden', historySubView !== 'wrongbank');

    if (historySubView === 'attempts') {
      if (!history.length) {
        $('attemptsList').innerHTML = `
          <div class="empty-state">
            <div class="empty-emoji">📝</div>
            <h3>Bột chưa hoàn thành đề thi nào</h3>
            <p>Hãy sang mục <strong>Thi thử 60 câu</strong> để làm thử 1 đề, hệ thống sẽ tự lưu điểm và chi tiết từng câu đúng/sai tại đây!</p>
            <button class="btn btn-primary" id="goExamEmptyBtn">🚀 Làm đề 60 câu ngay</button>
          </div>`;
        const b = $('goExamEmptyBtn');
        if (b) b.addEventListener('click', () => switchTab('exam'));
        return;
      }

      $('attemptsList').innerHTML = history
        .map((a, idx) => {
          const wrong = a.total - a.correct;
          return `
          <div class="attempt-card">
            <div class="attempt-left">
              <div class="attempt-score-pill">
                ${a.scoreTen.toFixed(1)}
                <small>/10</small>
              </div>
              <div class="attempt-meta">
                <h4>Lần #${history.length - idx} • ${escapeHtml(a.sourceLabel)}</h4>
                <p>✅ ${a.correct} đúng • ❌ ${wrong} sai • ⏱ ${formatDuration(a.durationSec)} • 🕒 ${formatDateTime(a.finishedAt)}</p>
              </div>
            </div>
            <div class="attempt-actions">
              <button type="button" class="btn btn-primary btn-sm" data-view-attempt="${a.id}">👁️ Xem chi tiết đúng/sai</button>
              <button type="button" class="btn btn-soft btn-sm" data-practice-attempt-wrong="${a.id}" ${wrong === 0 ? 'disabled' : ''}>🔁 Ôn ${wrong} câu sai</button>
              <button type="button" class="btn btn-danger-outline btn-xs" data-del-attempt="${a.id}" title="Xóa lịch sử này">🗑️</button>
            </div>
          </div>`;
        })
        .join('');
    } else {
      // Wrong/right per-question analytics
      let list = [];
      if (statsFilter === 'wrong') {
        list = QUESTIONS.filter((q) => (state.stats[q.id]?.wrong || 0) > 0)
          .sort((a, b) => (state.stats[b.id].wrong - state.stats[a.id].wrong) || (state.stats[b.id].lastAt - state.stats[a.id].lastAt));
      } else if (statsFilter === 'right') {
        list = QUESTIONS.filter((q) => (state.stats[q.id]?.right || 0) > 0)
          .sort((a, b) => state.stats[b.id].right - state.stats[a.id].right);
      } else {
        list = QUESTIONS.filter((q) => state.stats[q.id])
          .sort((a, b) => (state.stats[b.id].lastAt || 0) - (state.stats[a.id].lastAt || 0));
      }

      $('practiceAllWrongBtn').disabled = wrongUnique === 0;

      if (!list.length) {
        $('wrongStatsList').innerHTML = `<div class="empty-state"><div class="empty-emoji">📊</div><h3>Chưa có dữ liệu thống kê cho bộ lọc này</h3><p>Khi Bột làm bài ở mục <strong>Học bài</strong> hoặc <strong>Thi thử 60 câu</strong>, từng câu đúng/sai sẽ tự động lưu tại đây.</p></div>`;
        return;
      }

      $('wrongStatsList').innerHTML = list.map((q) => renderBankCardHtml(q, true, true)).join('');
    }
  }

  // ==================== TAB 6: QUESTION BANK & FAVORITES ====================
  function getBankFilteredQuestions() {
    const query = normalizeVN($('bankSearchInput').value.trim());
    return QUESTIONS.filter((q) => {
      if (bankFilter === 'favorite' && !isFav(q.id)) return false;
      if (bankFilter === 'mastered' && state.progress[q.id] !== 'mastered') return false;
      if (bankFilter === 'learning' && state.progress[q.id] !== 'learning') return false;
      if (bankFilter === 'wrong' && !hasBeenWrong(q.id)) return false;
      if (bankFilter === 'unseen' && state.progress[q.id]) return false;

      if (!query) return true;
      const hay = normalizeVN(`cau ${q.id} ${q.question} ${q.options.map((o) => o.text).join(' ')} ${q.note || ''}`);
      return hay.includes(query);
    });
  }

  function renderBankCardHtml(q, showAns, hlOn) {
    const fav = isFav(q.id);
    const st = getStatusLabel(q.id);
    const stat = state.stats[q.id];
    const rwHtml = stat
      ? `<span class="stat-rw-pill"><span class="rw-ok">✓ ${stat.right}</span> / <span class="rw-err">✕ ${stat.wrong}</span></span>`
      : '';
    return `
      <article class="bank-item">
        <div class="bank-item-head">
          <div class="bank-head-left">
            <span class="q-tag">Câu ${q.id}</span>
            <span class="status-badge ${st.cls}">${st.text}</span>
            ${q.answer.length > 1 ? `<span class="multi-badge">Chọn ${q.answer.length} đáp án</span>` : ''}
            ${rwHtml}
          </div>
          <div class="bank-head-right">
            <button type="button" class="btn btn-soft btn-xs" data-open-q="${q.id}">Xem nhanh</button>
            <button type="button" class="heart-btn ${fav ? 'active' : ''}" data-heart-qid="${q.id}" title="Thả tim lưu câu hỏi">${fav ? '❤️' : '🤍'}</button>
          </div>
        </div>
        <div class="bank-q-text">${renderHighlightedText(q.question, q.qHighlight, hlOn)}</div>
        <div class="bank-opts">
          ${q.options
            .map((o) => {
              const isAns = showAns && q.answer.includes(o.key);
              const content = isAns ? renderHighlightedText(o.text, o.hl, hlOn) : escapeHtml(o.text);
              return `<div class="bank-opt ${isAns ? 'is-ans' : ''}"><strong>${o.key}.</strong> ${content}${isAns ? ' ✓' : ''}</div>`;
            })
            .join('')}
        </div>
        ${q.note ? `<div class="fc-note-box" style="margin-top:8px;">💡 ${escapeHtml(q.note)}</div>` : ''}
        <div class="bank-foot">
          <div class="fc-tips-inline" style="padding-top:0;margin-top:0;">${buildTipPillsHtml(q.id)}</div>
        </div>
      </article>`;
  }

  function renderBank() {
    $('bankShowAnsToggle').checked = !!state.prefs.bankShowAns;
    $('bankHighlightToggle').checked = !!state.prefs.bankHighlight;
    document.querySelectorAll('#bankFilterChips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.bfilter === bankFilter);
    });

    const list = getBankFilteredQuestions();
    $('bankResultMeta').textContent = `Hiển thị ${list.length} / ${QUESTIONS.length} câu hỏi`;

    if (!list.length) {
      $('bankList').innerHTML = `<div class="empty-state"><div class="empty-emoji">🌸</div><h3>Không có câu hỏi nào phù hợp</h3><p>Hãy thử đổi từ khóa tìm kiếm hoặc chọn bộ lọc khác nhé.</p></div>`;
      return;
    }

    const showAns = !!state.prefs.bankShowAns;
    const hlOn = !!state.prefs.bankHighlight;
    $('bankList').innerHTML = list.map((q) => renderBankCardHtml(q, showAns, hlOn)).join('');
  }

  // ==================== QUESTION QUICK-VIEW MODAL ====================
  function openQuestionModal(qid) {
    const q = Q_BY_ID.get(qid);
    if (!q) return;
    qmCurrentId = qid;
    qmShowAns = true;
    renderQuestionModal();
    $('questionModal').classList.remove('hidden');
  }

  function renderQuestionModal() {
    const q = Q_BY_ID.get(qmCurrentId);
    if (!q) return;
    $('qmTitle').textContent = `Câu ${q.id}${q.answer.length > 1 ? ' • Nhiều đáp án' : ''}`;
    const st = getStatusLabel(q.id);
    const sb = $('qmStatus');
    sb.textContent = st.text;
    sb.className = `status-badge ${st.cls}`;
    setHeartUI($('qmHeartBtn'), isFav(q.id));

    $('qmQuestion').innerHTML = renderHighlightedText(q.question, q.qHighlight, true);
    $('qmOptions').innerHTML = q.options
      .map((o) => {
        const isAns = qmShowAns && q.answer.includes(o.key);
        return `<div class="qm-opt ${isAns ? 'qm-ans' : ''}"><strong>${o.key}.</strong> ${isAns ? renderHighlightedText(o.text, o.hl, true) : escapeHtml(o.text)}${isAns ? ' ✓' : ''}</div>`;
      })
      .join('');

    const noteEl = $('qmNote');
    if (q.note) {
      noteEl.textContent = `💡 Ghi chú: ${q.note}`;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }
    $('qmTips').innerHTML = buildTipPillsHtml(q.id);

    const isM = state.progress[q.id] === 'mastered';
    $('qmMarkMasteredBtn').textContent = isM ? '✓ Đã thuộc (Bấm để bỏ)' : '✓ Đánh dấu đã thuộc';
  }

  function closeQuestionModal() {
    $('questionModal').classList.add('hidden');
    qmCurrentId = null;
  }

  // ==================== EVENT LISTENERS ====================
  function bindEvents() {
    // Header & Nav
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'exam' && viewingResultAttempt && currentTab === 'exam') {
          viewingResultAttempt = null;
        }
        switchTab(btn.dataset.tab);
      });
    });

    $('brandHome').addEventListener('click', () => switchTab('flashcards'));
    $('hdrFavBtn').addEventListener('click', () => {
      bankFilter = 'favorite';
      switchTab('bank');
    });

    // Global delegated heart toggle in lists (bank / review / stats)
    document.addEventListener('click', (e) => {
      const hBtn = e.target.closest('[data-heart-qid]');
      if (!hBtn) return;
      e.stopPropagation();
      const qid = hBtn.dataset.heartQid;
      const fav = toggleFavorite(qid);
      setHeartUI(hBtn, fav);
      if (currentTab === 'bank' && bankFilter === 'favorite') renderBank();
      if (currentTab === 'exam' && viewingResultAttempt && resFilter === 'favorite') renderExamResult(viewingResultAttempt);
    });

    // Flashcard Events
    $('fcFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      fcCustomSet = null;
      state.prefs.fcFilter = chip.dataset.filter;
      saveState();
      rebuildFlashcardDeck(false);
    });

    $('fcHighlightToggle').addEventListener('change', (e) => {
      state.prefs.fcHighlight = e.target.checked;
      saveState();
      renderFlashcard();
    });

    $('fcShuffleBtn').addEventListener('click', () => {
      fcDeck = shuffleArray(fcDeck);
      fcIdx = 0;
      renderFlashcard();
      showToast('🔀 Đã trộn ngẫu nhiên bộ thẻ!');
    });

    $('fcResetOrderBtn').addEventListener('click', () => {
      rebuildFlashcardDeck(false);
      showToast('↺ Đã sắp xếp lại theo thứ tự gốc!');
    });

    $('fcClearCustomBtn').addEventListener('click', () => {
      fcCustomSet = null;
      rebuildFlashcardDeck(false);
    });

    $('fcBackAllBtn').addEventListener('click', () => {
      fcCustomSet = null;
      state.prefs.fcFilter = 'all';
      saveState();
      rebuildFlashcardDeck(false);
    });

    $('fcCard').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      $('fcCard').classList.toggle('is-flipped');
    });

    $('fcFlipBtn').addEventListener('click', () => $('fcCard').classList.toggle('is-flipped'));
    $('fcPrevBtn').addEventListener('click', () => {
      if (fcIdx > 0) { fcIdx--; renderFlashcard(); }
    });
    $('fcNextBtn').addEventListener('click', () => {
      if (fcIdx < fcDeck.length - 1) { fcIdx++; renderFlashcard(); }
    });
    $('fcLearningBtn').addEventListener('click', () => rateFlashcard('learning'));
    $('fcMasteredBtn').addEventListener('click', () => rateFlashcard('mastered'));
    $('fcHeartBtn').addEventListener('click', () => {
      if (!fcDeck.length) return;
      const fav = toggleFavorite(fcDeck[fcIdx]);
      setHeartUI($('fcHeartBtn'), fav);
    });

    const handleFcJump = () => {
      const raw = $('fcJumpInput').value.trim();
      if (!raw) return;
      let idx = fcDeck.findIndex((id) => id.toLowerCase() === raw.toLowerCase());
      if (idx === -1) {
        // Also allow searching in all questions
        const allIdx = QUESTIONS.findIndex((q) => q.id.toLowerCase() === raw.toLowerCase());
        if (allIdx >= 0) {
          fcCustomSet = null;
          state.prefs.fcFilter = 'all';
          fcDeck = QUESTIONS.map((q) => q.id);
          idx = allIdx;
        }
      }
      if (idx >= 0) {
        fcIdx = idx;
        renderFlashcard();
        $('fcJumpInput').value = '';
      } else {
        showToast(`Không tìm thấy Câu ${raw} (nhập 1–413, 106a/b, 318a/b)`);
      }
    };
    $('fcJumpBtn').addEventListener('click', handleFcJump);
    $('fcJumpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleFcJump(); });

    // Keyboard shortcuts for Flashcards
    document.addEventListener('keydown', (e) => {
      if (currentTab !== 'flashcards') return;
      if (!$('questionModal').classList.contains('hidden') || !$('settingsModal').classList.contains('hidden')) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (!fcDeck.length) return;

      if (e.code === 'Space') {
        e.preventDefault();
        $('fcCard').classList.toggle('is-flipped');
      } else if (e.key === 'ArrowRight') {
        if (fcIdx < fcDeck.length - 1) { fcIdx++; renderFlashcard(); }
      } else if (e.key === 'ArrowLeft') {
        if (fcIdx > 0) { fcIdx--; renderFlashcard(); }
      } else if (e.key === '1') {
        rateFlashcard('learning');
      } else if (e.key === '2') {
        rateFlashcard('mastered');
      } else if (e.key.toLowerCase() === 'h') {
        const fav = toggleFavorite(fcDeck[fcIdx]);
        setHeartUI($('fcHeartBtn'), fav);
      }
    });

    // Learn Mode Events
    $('learnFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      learnCustomSet = null;
      state.prefs.learnFilter = chip.dataset.filter;
      saveState();
      buildLearnDeck();
    });

    $('learnShuffleOpt').addEventListener('change', (e) => {
      state.prefs.learnShuffleOpt = e.target.checked;
      saveState();
      renderLearnQuestion();
    });

    $('learnHighlightToggle').addEventListener('change', (e) => {
      state.prefs.learnHighlight = e.target.checked;
      saveState();
      renderLearnQuestion();
    });

    $('learnRestartBtn').addEventListener('click', () => {
      learnDeck = shuffleArray(learnDeck);
      learnIdx = 0;
      renderLearnQuestion();
      showToast('🔀 Đã đảo thứ tự câu hỏi!');
    });

    $('learnClearCustomBtn').addEventListener('click', () => {
      learnCustomSet = null;
      buildLearnDeck();
    });

    $('learnBackAllBtn').addEventListener('click', () => {
      learnCustomSet = null;
      state.prefs.learnFilter = 'all';
      saveState();
      buildLearnDeck();
    });

    $('learnHeartBtn').addEventListener('click', () => {
      if (!learnDeck.length) return;
      const fav = toggleFavorite(learnDeck[learnIdx]);
      setHeartUI($('learnHeartBtn'), fav);
    });

    $('learnOptions').addEventListener('click', (e) => {
      const btn = e.target.closest('.opt-btn');
      if (!btn || learnCurrentAnswered) return;
      const q = Q_BY_ID.get(learnDeck[learnIdx]);
      const key = btn.dataset.optKey;

      if (q.answer.length > 1) {
        if (learnSelectedKeys.has(key)) {
          learnSelectedKeys.delete(key);
          btn.classList.remove('selected');
        } else {
          learnSelectedKeys.add(key);
          btn.classList.add('selected');
        }
        $('learnMultiSubmitBtn').disabled = learnSelectedKeys.size === 0;
      } else {
        evaluateLearnAnswer(q, [key]);
      }
    });

    $('learnMultiSubmitBtn').addEventListener('click', () => {
      if (learnCurrentAnswered || !learnSelectedKeys.size) return;
      const q = Q_BY_ID.get(learnDeck[learnIdx]);
      evaluateLearnAnswer(q, [...learnSelectedKeys]);
    });

    $('learnPrevBtn').addEventListener('click', () => {
      if (learnIdx > 0) { learnIdx--; renderLearnQuestion(); }
    });

    const goNextLearn = () => {
      if (learnIdx < learnDeck.length - 1) {
        learnIdx++;
        renderLearnQuestion();
      } else {
        showToast(`🎉 Hoàn thành phiên học (${learnSessionRight} đúng • ${learnSessionWrong} sai)!`);
        learnIdx = 0;
        renderLearnQuestion();
      }
    };
    $('learnNextBtn').addEventListener('click', goNextLearn);
    $('learnSkipBtn').addEventListener('click', goNextLearn);

    // Exam Events
    $('startExamBtn').addEventListener('click', startNewExam);
    $('examResumeBtn').addEventListener('click', () => {
      if (!state.activeExam) return;
      state.activeExam.inView = true;
      saveState();
      renderExamTabState();
    });
    $('examDiscardBtn').addEventListener('click', () => {
      if (confirm('Hủy đề thi đang làm dở này?')) {
        state.activeExam = null;
        saveState();
        renderExamTabState();
      }
    });

    $('examOptionsList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-exam-key]');
      if (!btn || !state.activeExam) return;
      const ex = state.activeExam;
      const q = Q_BY_ID.get(ex.questions[ex.currentIdx].qid);
      const key = btn.dataset.examKey;

      if (q.answer.length > 1) {
        const prev = new Set(ex.answers[ex.currentIdx] || []);
        if (prev.has(key)) prev.delete(key);
        else prev.add(key);
        ex.answers[ex.currentIdx] = [...prev];
      } else {
        ex.answers[ex.currentIdx] = [key];
      }
      saveState();
      renderActiveExamQuestion();
    });

    $('examNavGrid').addEventListener('click', (e) => {
      const cell = e.target.closest('[data-exam-goto]');
      if (!cell || !state.activeExam) return;
      state.activeExam.currentIdx = parseInt(cell.dataset.examGoto, 10);
      saveState();
      renderActiveExamQuestion();
    });

    $('examPrevBtn').addEventListener('click', () => {
      if (state.activeExam && state.activeExam.currentIdx > 0) {
        state.activeExam.currentIdx--;
        saveState();
        renderActiveExamQuestion();
      }
    });

    $('examNextBtn').addEventListener('click', () => {
      if (state.activeExam && state.activeExam.currentIdx < state.activeExam.questions.length - 1) {
        state.activeExam.currentIdx++;
        saveState();
        renderActiveExamQuestion();
      }
    });

    $('examFlagBtn').addEventListener('click', () => {
      if (!state.activeExam) return;
      const i = state.activeExam.currentIdx;
      state.activeExam.flags[i] = !state.activeExam.flags[i];
      saveState();
      renderActiveExamQuestion();
    });

    $('examHeartBtn').addEventListener('click', () => {
      if (!state.activeExam) return;
      const qid = state.activeExam.questions[state.activeExam.currentIdx].qid;
      const fav = toggleFavorite(qid);
      setHeartUI($('examHeartBtn'), fav);
    });

    $('submitExamBtn').addEventListener('click', () => submitActiveExam(false));
    $('quitExamBtn').addEventListener('click', () => {
      if (state.activeExam) {
        state.activeExam.inView = false;
        saveState();
        stopExamTimer();
        renderExamTabState();
        showToast('💾 Đã lưu tạm đề thi! Bột có thể quay lại làm tiếp bất cứ lúc nào.');
      }
    });

    $('resFilterChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !viewingResultAttempt) return;
      resFilter = chip.dataset.filter;
      renderExamResult(viewingResultAttempt);
    });

    $('resNewExamBtn').addEventListener('click', () => {
      viewingResultAttempt = null;
      renderExamTabState();
    });

    $('resPracticeWrongBtn').addEventListener('click', () => {
      if (!viewingResultAttempt) return;
      const wrongIds = viewingResultAttempt.items.filter((it) => !it.isRight).map((it) => it.qid);
      if (wrongIds.length) {
        openCustomLearn(`Ôn lại ${wrongIds.length} câu làm sai trong đề`, wrongIds);
      }
    });

    // Tips Events
    $('tipsGroupChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      tipsGroup = chip.dataset.group;
      document.querySelectorAll('#tipsGroupChips .chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.group === tipsGroup);
      });
      renderTips();
    });

    $('tipsSearchInput').addEventListener('input', renderTips);

    $('tipsGrid').addEventListener('click', (e) => {
      const fcBtn = e.target.closest('[data-tip-fc]');
      if (fcBtn) {
        const tip = TIP_BY_ID.get(fcBtn.dataset.tipFc);
        if (tip) openCustomFlashcards(tip.title, tip.questionIds);
        return;
      }
      const lrnBtn = e.target.closest('[data-tip-learn]');
      if (lrnBtn) {
        const tip = TIP_BY_ID.get(lrnBtn.dataset.tipLearn);
        if (tip) openCustomLearn(tip.title, tip.questionIds);
      }
    });

    // History Events
    document.querySelector('.history-subtabs').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      historySubView = chip.dataset.hview;
      document.querySelectorAll('.history-subtabs .chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.hview === historySubView);
      });
      renderHistoryTab();
    });

    $('statsFilterChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      statsFilter = chip.dataset.sfilter;
      document.querySelectorAll('#statsFilterChips .chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.sfilter === statsFilter);
      });
      renderHistoryTab();
    });

    $('practiceAllWrongBtn').addEventListener('click', () => {
      const ids = QUESTIONS.filter((q) => hasBeenWrong(q.id)).map((q) => q.id);
      if (ids.length) openCustomLearn(`Toàn bộ câu từng làm sai (${ids.length} câu)`, ids);
    });

    $('attemptsList').addEventListener('click', (e) => {
      const viewBtn = e.target.closest('[data-view-attempt]');
      if (viewBtn) {
        const att = state.examHistory.find((a) => a.id === viewBtn.dataset.viewAttempt);
        if (att) {
          viewingResultAttempt = att;
          resFilter = 'all';
          switchTab('exam');
        }
        return;
      }
      const pracBtn = e.target.closest('[data-practice-attempt-wrong]');
      if (pracBtn) {
        const att = state.examHistory.find((a) => a.id === pracBtn.dataset.practiceAttemptWrong);
        if (att) {
          const wrongIds = att.items.filter((it) => !it.isRight).map((it) => it.qid);
          if (wrongIds.length) openCustomLearn(`Ôn lại câu sai (${att.sourceLabel})`, wrongIds);
        }
        return;
      }
      const delBtn = e.target.closest('[data-del-attempt]');
      if (delBtn) {
        if (confirm('Xóa lần làm đề này khỏi lịch sử?')) {
          state.examHistory = state.examHistory.filter((a) => a.id !== delBtn.dataset.delAttempt);
          saveState();
          renderHistoryTab();
          showToast('Đã xóa bản ghi lịch sử!');
        }
      }
    });

    // Bank Events
    $('bankSearchInput').addEventListener('input', renderBank);
    $('bankShowAnsToggle').addEventListener('change', (e) => {
      state.prefs.bankShowAns = e.target.checked;
      saveState();
      renderBank();
    });
    $('bankHighlightToggle').addEventListener('change', (e) => {
      state.prefs.bankHighlight = e.target.checked;
      saveState();
      renderBank();
    });
    $('bankFilterChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      bankFilter = chip.dataset.bfilter;
      renderBank();
    });

    $('bankToFlashcardBtn').addEventListener('click', () => {
      const ids = getBankFilteredQuestions().map((q) => q.id);
      if (!ids.length) return showToast('Không có câu nào để tạo thẻ!');
      openCustomFlashcards(`Bộ lọc Kho câu (${ids.length} câu)`, ids);
    });

    $('bankToLearnBtn').addEventListener('click', () => {
      const ids = getBankFilteredQuestions().map((q) => q.id);
      if (!ids.length) return showToast('Không có câu nào để học!');
      openCustomLearn(`Bộ lọc Kho câu (${ids.length} câu)`, ids);
    });

    // Quick-View Modal Events
    $('qmCloseBtn').addEventListener('click', closeQuestionModal);
    $('questionModal').addEventListener('click', (e) => {
      if (e.target === $('questionModal')) closeQuestionModal();
    });
    $('qmHeartBtn').addEventListener('click', () => {
      if (!qmCurrentId) return;
      toggleFavorite(qmCurrentId);
      renderQuestionModal();
      if (currentTab === 'tips') renderTips();
      if (currentTab === 'bank') renderBank();
    });
    $('qmToggleAnsBtn').addEventListener('click', () => {
      qmShowAns = !qmShowAns;
      renderQuestionModal();
    });
    $('qmOpenFcBtn').addEventListener('click', () => {
      if (qmCurrentId) openSingleQuestionInFlashcard(qmCurrentId);
    });
    $('qmMarkMasteredBtn').addEventListener('click', () => {
      if (!qmCurrentId) return;
      if (state.progress[qmCurrentId] === 'mastered') delete state.progress[qmCurrentId];
      else state.progress[qmCurrentId] = 'mastered';
      saveState();
      renderQuestionModal();
      if (currentTab === 'tips') renderTips();
      if (currentTab === 'bank') renderBank();
    });

    // Settings / Backup Modal Events
    $('openSettingsBtn').addEventListener('click', () => $('settingsModal').classList.remove('hidden'));
    $('smCloseBtn').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('settingsModal').addEventListener('click', (e) => {
      if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden');
    });

    $('exportDataBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bot-iuu-vnr202-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('⬇️ Đã tải file sao lưu tiến trình!');
    });

    $('importDataInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || typeof parsed !== 'object') throw new Error('Invalid');
          state = {
            ...defaultState(),
            ...parsed,
            prefs: { ...defaultState().prefs, ...(parsed.prefs || {}) }
          };
          saveState();
          rebuildFlashcardDeck(false);
          buildLearnDeck();
          $('settingsModal').classList.add('hidden');
          showToast('✅ Khôi phục tiến trình thành công!');
        } catch (err) {
          showToast('❌ File sao lưu không hợp lệ!');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('resetAllDataBtn').addEventListener('click', () => {
      if (confirm('Bột có chắc muốn XÓA TOÀN BỘ tiến trình, câu thả tim và lịch sử làm đề không?')) {
        state = defaultState();
        viewingResultAttempt = null;
        fcCustomSet = null;
        learnCustomSet = null;
        saveState();
        rebuildFlashcardDeck(false);
        buildLearnDeck();
        renderExamTabState();
        $('settingsModal').classList.add('hidden');
        showToast('🗑️ Đã đặt lại toàn bộ dữ liệu học tập!');
      }
    });

    // Escape closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeQuestionModal();
        $('settingsModal').classList.add('hidden');
      }
    });
  }

  // ==================== INIT ====================
  function init() {
    updateHeaderStats();
    bindEvents();
    rebuildFlashcardDeck(false);
  }

  init();
})();
