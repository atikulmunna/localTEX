import {test,expect} from '@playwright/test';
test('renders real PDF pages, selectable text, zoom, inverse coordinates and refresh',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const remoteRequests:string[]=[];page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:1420')&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))remoteRequests.push(request.url());});
  await page.goto('/tests/preview-harness.html');
  await expect(page.locator('.textLayer')).toContainText('A real PDF preview');
  await expect(page.locator('.pdf-page canvas')).toBeVisible();
  await page.getByRole('button',{name:'Next page'}).click();await expect(page.locator('.textLayer')).toContainText('The second page');
  await page.getByRole('button',{name:'Zoom in'}).click();await expect(page.locator('.pdf-controls')).toContainText('110%');
  await page.locator('.pdf-page').dblclick({position:{x:80,y:80}});await expect(page.getByRole('status',{name:'Inverse position'})).toHaveText(/^2:/);
  await page.getByRole('button',{name:'Mark stale'}).click();await expect(page.getByText('Previous build')).toBeVisible();
  await page.getByRole('button',{name:'Rebuild PDF'}).click();await expect(page.locator('.textLayer')).toContainText('The second page');
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
