(function () {
  var theme = null
  try { theme = localStorage.getItem('buracle.brain.theme') } catch (e) {  }
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
})()
