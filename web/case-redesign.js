// Trial redesign: presentation-only enhancement for full extraction results.
(() => {
  const root = document.querySelector('#resultContent');
  if (!root) return;

  const titleOf = (section) => section?.querySelector(':scope > header h3')?.textContent?.trim() || '';

  function markIndexes(section) {
    [...section.querySelectorAll('.list-card')].forEach((card, index) => {
      card.dataset.readerIndex = String(index + 1).padStart(2, '0');
    });
  }

  function addResultChips(section) {
    section.querySelectorAll('.list-card small').forEach((small) => {
      const match = small.textContent.match(/Result:\s*([^·\n]+)/i);
      if (!match) return;
      const strong = small.closest('.list-card')?.querySelector('b');
      if (!strong || strong.querySelector('.reader-result-chip')) return;
      const chip = document.createElement('span');
      chip.className = 'reader-result-chip';
      chip.textContent = match[1].trim();
      strong.appendChild(chip);
    });
  }

  function makeCollapsible(section, open = false) {
    section.classList.add('reader-collapsible');
    if (open) section.classList.add('is-open');
    const header = section.querySelector(':scope > header');
    if (!header || header.dataset.readerToggle === '1') return;
    header.dataset.readerToggle = '1';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    const toggle = () => section.classList.toggle('is-open');
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }

  function redesign() {
    const sections = [...root.querySelectorAll(':scope > .result-section')];
    if (!sections.length) return;
    if (root.dataset.readerDone === '1' && sections.every((s) => s.dataset.readerDone === '1')) return;

    root.classList.add('case-reader');
    root.dataset.readerDone = '1';

    const byTitle = new Map(sections.map((section) => [titleOf(section), section]));

    const identity = byTitle.get('Identity and classification');
    const ratio = byTitle.get('Ratio decidendi');
    const facts = byTitle.get('Material facts');
    const factsProcedure = byTitle.get('Facts and procedure');
    const grounds = byTitle.get('Grounds and issues');
    const legalIssues = byTitle.get('Legal issues determined');
    const judicial = byTitle.get('Judicial analysis');
    const outcome = byTitle.get('Outcome, orders and money');
    const legislation = byTitle.get('Legislation and provisions');
    const authorities = byTitle.get('Cited authorities');

    if (ratio) ratio.classList.add('reader-key-principle', 'reader-primary');
    [identity, facts, grounds, judicial, outcome].filter(Boolean).forEach((section) => section.classList.add('reader-primary'));

    if (grounds && legalIssues && !grounds.querySelector('.reader-issues-bridge')) {
      const bridge = document.createElement('div');
      bridge.className = 'reader-issues-bridge';
      bridge.innerHTML = '<strong>Legal questions determined</strong><p>The legal questions are shown here with the grounds so the reader does not have to reconcile two separate sections.</p>';
      const legalBody = legalIssues.querySelector(':scope > .result-section-body');
      if (legalBody) bridge.append(...legalBody.childNodes);
      grounds.querySelector(':scope > .result-section-body')?.appendChild(bridge);
      legalIssues.remove();
    }

    const desired = [
      identity,
      ratio,
      facts,
      factsProcedure,
      grounds,
      judicial,
      outcome,
      legislation,
      authorities,
    ].filter(Boolean);

    const used = new Set(desired);
    const remaining = sections.filter((section) => !used.has(section) && section.isConnected);
    [...desired, ...remaining].forEach((section) => root.appendChild(section));

    const secondaryTitles = new Set([
      'Chronology',
      'Witnesses and evidence',
      'Party submissions',
      'Secondary legal principles',
      'Judicial findings',
      'Component outcomes',
      'Conflicts and review gate',
      'Section map',
      'Raw structured result',
    ]);

    [...root.querySelectorAll(':scope > .result-section')].forEach((section) => {
      section.dataset.readerDone = '1';
      markIndexes(section);
      addResultChips(section);
      const title = titleOf(section);
      if (secondaryTitles.has(title)) {
        section.classList.add('reader-secondary');
        makeCollapsible(section, false);
      }
      if (title === 'Legislation and provisions' || title === 'Cited authorities') {
        makeCollapsible(section, false);
      }
    });

    if (ratio) root.insertBefore(ratio, identity?.nextSibling || root.firstChild);
  }

  const observer = new MutationObserver(() => redesign());
  observer.observe(root, { childList: true, subtree: true });
  redesign();
})();
