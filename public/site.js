// Mobile nav toggle
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  // Terminal typing demo (home page hero)
  const term = document.getElementById('termBody');
  if (term) {
    const script = [
      { cmd: '.menu', reply: 'ISHAN-X MD PRO — 225+ commands loaded ✅' },
      { cmd: '.ytmp3 https://youtu.be/…', reply: 'Fetching audio… done. Sent as voice note 🎧' },
      { cmd: '.sticker', reply: 'Image converted to sticker ✨' },
      { cmd: '.tagall', reply: 'Tagged 42 members in Family Chat 📢' },
    ];
    let i = 0;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function typeLine(text, el, speed, done) {
      let j = 0;
      el.textContent = '';
      const t = setInterval(() => {
        el.textContent += text[j];
        j++;
        if (j >= text.length) { clearInterval(t); done && done(); }
      }, speed);
    }

    function runStep() {
      if (i >= script.length) { i = 0; }
      const { cmd, reply } = script[i];
      const line = document.createElement('p');
      line.className = 'term-line';
      const prompt = document.createElement('span');
      prompt.className = 'prompt';
      prompt.textContent = '❯ ';
      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'cmd';
      line.appendChild(prompt);
      line.appendChild(cmdSpan);
      term.appendChild(line);

      const finish = () => {
        const reply_el = document.createElement('div');
        reply_el.className = 'term-reply';
        reply_el.textContent = reply;
        term.appendChild(reply_el);
        term.scrollTop = term.scrollHeight;
        i++;
        if (term.children.length > 10) {
          term.removeChild(term.firstChild);
          term.removeChild(term.firstChild);
        }
        setTimeout(runStep, 1600);
      };

      if (prefersReduced) {
        cmdSpan.textContent = cmd;
        finish();
      } else {
        typeLine(cmd, cmdSpan, 45, finish);
      }
    }
    runStep();
  }
});
