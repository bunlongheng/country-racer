import { test, expect } from "@playwright/test";

test("loads the racer canvas", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("a race runs to a 3-country podium and can race again", async ({
  page,
}) => {
  await page.goto("/");

  // Setup screen: drop to a single lap so the race finishes quickly, then start.
  await page.getByRole("button", { name: "Decrease round" }).click();
  await page.getByRole("button", { name: "Decrease round" }).click();
  await page.getByRole("button", { name: "Start Race" }).click();

  // The Winners screen appears with gold, silver, and bronze.
  await expect(page.getByRole("heading", { name: "Winners" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("🥇")).toBeVisible();
  await expect(page.getByText("🥈")).toBeVisible();
  await expect(page.getByText("🥉")).toBeVisible();

  // Racing again dismisses the podium and starts a fresh race.
  await page.getByRole("button", { name: "Race Again" }).click();
  await expect(page.getByRole("heading", { name: "Winners" })).toHaveCount(0);
});
