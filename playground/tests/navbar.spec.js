/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Navbar: two sides, one of them on the right, and a collapse that opens.
 *
 * The right-hand group used to sit directly after the left one. It was not a
 * styling slip: the <nav> is a flex item of .navbar and was sized to its content,
 * so the row had no free space at all -- and `ms-auto` cannot push anything when
 * there is nothing left to distribute. `flex-grow-1` on the <nav> makes the row
 * span the page, and on the left group so the right one ends up at the edge.
 */

import { expect, test } from 'playwright/test'

import { openPlayground } from './helpers.js'

/** Geometry of the two navbar groups, in CSS pixels. */
async function navbarGeometry(page) {
    return page.evaluate(() => {
        const nav = document.querySelector('header nav')
        const collapse = document.getElementById('bdNavbar')
        const groups = [...collapse.querySelectorAll(':scope > ul')]
        const leftLinks = [...groups[0].querySelectorAll('.nav-link')]
        const box = el => el.getBoundingClientRect()
        const collapseStyle = getComputedStyle(collapse)

        return {
            navWidth: Math.round(box(nav).width),
            viewport: window.innerWidth,
            // Distance from the last left-hand link to the first right-hand item.
            gap: Math.round(box(groups[1]).left - box(leftLinks[leftLinks.length - 1]).right),
            // Distance from the right group's edge to the row's content edge; the
            // group's own me-5 is expected to account for it.
            rightInset: Math.round(box(collapse).right - Number.parseFloat(collapseStyle.paddingRight) - box(groups[1]).right),
            leftLinks: leftLinks.map(link => link.textContent.trim()),
            rightLinks: [...groups[1].querySelectorAll('.nav-link')].map(link => link.textContent.trim()),
            // A horizontally scrolling document is a layout failure, not a style choice.
            overflow: document.documentElement.scrollWidth - window.innerWidth
        }
    })
}

test.describe('navbar', () => {
    test('the two groups are on their own sides', async ({ page }) => {
        await openPlayground(page)

        const wide = await navbarGeometry(page)
        expect(wide.leftLinks.length).toBeGreaterThan(1)
        expect(wide.rightLinks.length).toBeGreaterThan(0)
        // Two groups, not one: the right-hand links are all after the left-hand ones.
        // gap-3 on the collapse guarantees the separation; flex-grow only spreads slack,
        // so a positive gap used to depend on the fallback font's width.
        expect(wide.gap).toBeGreaterThan(0)
        // ... and the right group is against the row's right edge, inset only by its
        // own margin.
        expect(wide.rightInset).toBe(48)
        expect(wide.overflow).toBeLessThanOrEqual(0)
    })

    test('the right group stays right as the viewport grows', async ({ page }) => {
        await openPlayground(page)

        for (const width of [1100, 1280, 1440]) {
            await page.setViewportSize({ width, height: 900 })
            // Resizing reflows the sticky header, so re-read rather than trust the
            // value from the previous width.
            const geometry = await expect
                .poll(
                    async () => {
                        const measured = await navbarGeometry(page)
                        return measured.navWidth
                    },
                    { message: `nav width at ${width}px` }
                )
                .toBeGreaterThan(0)
                .then(() => navbarGeometry(page))

            expect(geometry.viewport).toBe(width)
            expect(geometry.overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
            // Whatever the width, the right group is inset only by its own margin.
            expect(geometry.rightInset, `right inset at ${width}px`).toBe(48)
            // And the nav spans the page rather than shrink-wrapping its content.
            expect(geometry.navWidth, `nav width at ${width}px`).toBeGreaterThan(width * 0.75)
        }
    })

    test('the nav is the same on the multi-run page', async ({ page }) => {
        await page.goto('/multi.html')
        await expect(page.locator('#version-select-1')).toBeAttached()

        const geometry = await navbarGeometry(page)
        expect(geometry.gap).toBeGreaterThan(0)
        expect(geometry.rightInset).toBe(48)
    })

    test('the collapse opens on a small screen', async ({ page }) => {
        // Needs Bootstrap's JS bundle. Without it the toggler has no handler at all,
        // so navigation is unreachable below the lg breakpoint.
        await page.setViewportSize({ width: 480, height: 900 })
        await openPlayground(page)

        expect(await page.evaluate(() => typeof window.bootstrap)).toBe('object')
        await expect(page.locator('#bdNavbar')).toBeHidden()

        const toggler = page.locator('.navbar-toggler')
        await toggler.click()
        await expect(page.locator('#bdNavbar')).toBeVisible()
        await expect(toggler).toHaveAttribute('aria-expanded', 'true')

        // Wait for the opening transition to finish: Bootstrap drops a click that
        // arrives while it is still animating, so a second click straight away is
        // ignored (the same would happen for a user clicking twice quickly).
        await expect(page.locator('#bdNavbar')).toHaveClass(/show/)

        await toggler.click()
        await expect(toggler).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator('#bdNavbar')).toBeHidden()
    })

    test('exactly one link claims to be the current page', async ({ page }) => {
        await openPlayground(page)

        // index.html marked both the playground link (class) and the multi-run link
        // (aria-current) as current.
        await expect(page.locator('#playground-link')).toHaveClass(/active/)
        await expect(page.locator('#multi-run-link')).not.toHaveClass(/active/)
        await expect(page.locator('a[aria-current="page"]')).toHaveCount(1)

        await page.goto('/multi.html')
        await expect(page.locator('#version-select-1')).toBeAttached()
        await expect(page.locator('#multi-run-link')).toHaveClass(/active/)
        await expect(page.locator('#playground-link')).not.toHaveClass(/active/)
        await expect(page.locator('a[aria-current="page"]')).toHaveCount(1)
    })
})
