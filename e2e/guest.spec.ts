import { test, expect } from "@playwright/test";
test("guest books, reschedules and cancels (keyboard-friendly controls)", async ({ page }) => {
  await page.goto("/demo/intro-30");
  await page.locator(".cal button:not([disabled])").first().click();
  await page.locator(".times button").first().click();
  await page.getByLabel("Name").fill("E2E Guest");
  await page.getByLabel("Email").fill(`e2e${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("You're booked")).toBeVisible();
  await page.getByRole("link", { name: "Manage booking" }).click();
  await expect(page.locator(".badge.ok")).toHaveText("confirmed");
  await page.locator(".cal button:not([disabled])").nth(2).click();
  await page.locator(".times button").nth(1).click();
  await expect(page.getByText("Booking rescheduled")).toBeVisible();
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(page.locator(".badge.bad")).toHaveText("cancelled");
});
