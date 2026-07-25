import { test, expect } from "@playwright/test";

test("loads the racer canvas", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
});

test("a full race runs to a 3-country podium and can race again", async ({
  page,
}) => {
  await page.goto("/");

  // The race is hard-bounded to under a minute; the podium appears with a
  // winner, a runner-up, and a third place.
  await expect(page.getByText("Podium")).toBeVisible({ timeout: 75_000 });
  await expect(page.getByText("🥇")).toBeVisible();
  await expect(page.getByText("🥈")).toBeVisible();
  await expect(page.getByText("🥉")).toBeVisible();

  const again = page.getByRole("button", { name: "Race Again" });
  await expect(again).toBeVisible();
  await again.click();

  // Racing again dismisses the podium.
  await expect(page.getByText("Podium")).toHaveCount(0);
});
