// A calm dusk over dunes, drawn in place of a real video (no third-party footage in the store images).
const SCENE = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22343f"/><stop offset=".55" stop-color="#6c7a78"/><stop offset=".82" stop-color="#d7b484"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#sky)"/>
<circle cx="1120" cy="515" r="62" fill="#f6e4ba"/>
<path d="M0 600 C 250 520 420 560 640 600 S 1100 520 1600 585 V900 H0Z" fill="#8a6848"/>
<path d="M0 700 C 300 610 520 640 760 690 S 1250 640 1600 705 V900 H0Z" fill="#a98057"/>
<path d="M0 820 C 260 720 600 730 900 790 S 1400 760 1600 805 V900 H0Z" fill="#c79d68"/>
<path d="M900 790 C 1100 762 1300 772 1600 805 V900 H1060 C 1010 862 965 822 900 790Z" fill="#b48857"/>
</svg>`;
for (const el of document.querySelectorAll('.scene')) el.innerHTML = SCENE;
