// Added by the iOS app before the page's own script runs. The app handles touch, safe areas and its phone layout
// itself; this tells it that it runs in the iOS app (TAPE_IOS: touch sizes, smaller memory limits) and turns off
// page zoom, since the chart pinches by itself.
window.TAPE_IOS = true;
document.addEventListener('DOMContentLoaded', () => {
  let meta = document.querySelector('meta[name=viewport]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
  meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  document.documentElement.classList.add('ios');
});
