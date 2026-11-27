'use strict';

const form = document.querySelector('#login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#login-error');
  const button = form.querySelector('button');
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error('登录请求较多，请稍后再试');
      throw new Error(response.status === 401 ? '账号或密码错误' : '登录失败，请稍后重试');
    }
    const admin = data.role === 'admin' && new URLSearchParams(location.search).get('next') === 'admin';
    location.replace(admin ? '/admin' : '/');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
