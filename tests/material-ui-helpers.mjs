export async function saveAndProcessLocal(page) {
  await page.locator('#save-material').click();
  await page.locator('#material-detail').waitFor();
  const local = page.locator('#process-material-local');
  if (!await local.isVisible()) await page.locator('details').filter({ has: local }).locator('summary').click();
  await local.click();
  await page.locator('#compile-candidates').waitFor();
}
