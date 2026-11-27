'use strict';

window.sessionFetch = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.replace(location.pathname.startsWith('/admin') ? '/login?next=admin' : '/login');
    throw new Error('请重新登录');
  }
  return response;
};

document.querySelector('#sign-out')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await window.sessionFetch('/api/v1/logout', { method: 'POST' });
    if (!response.ok) throw new Error();
    location.replace('/');
  } catch {
    button.textContent = '重试退出';
    button.disabled = false;
  }
});
