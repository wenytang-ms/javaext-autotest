import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { treeOperations } from "../src/drivers/operations/treeOperations.js";

describe("treeOperations visible matching", () => {
  it("waits on visible exact matches instead of the first hidden duplicate", async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const visibleMatches = {
      first: vi.fn().mockReturnValue({ waitFor }),
    };
    const exactMatches = {
      filter: vi.fn().mockReturnValue(visibleMatches),
    };
    const treeItems = {
      filter: vi.fn().mockReturnValue(exactMatches),
    };
    const page = {
      getByRole: vi.fn().mockReturnValue(treeItems),
      locator: vi.fn().mockReturnValue({}),
    } as unknown as Page;

    const found = await treeOperations.waitForTreeItem.call(
      { getPage: () => page },
      "tasks",
      1_234,
      true,
    );

    expect(found).toBe(true);
    expect(page.locator).toHaveBeenCalledWith(
      ".label-name",
      { hasText: expect.any(RegExp) },
    );
    expect(exactMatches.filter).toHaveBeenCalledWith({ visible: true });
    expect(waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 1_234,
    });
  });

  it("scopes tree-item lookup to a visible view pane", async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const visibleTreeItems = {
      first: vi.fn().mockReturnValue({ waitFor }),
    };
    const treeItems = {
      filter: vi.fn().mockReturnValue(visibleTreeItems),
    };
    const visiblePanes = {
      getByRole: vi.fn().mockReturnValue(treeItems),
    };
    const matchingPanes = {
      filter: vi.fn().mockReturnValue(visiblePanes),
    };
    const panes = {
      filter: vi.fn().mockReturnValue(matchingPanes),
    };
    const page = {
      getByRole: vi.fn(),
      locator: vi.fn((selector: string) => {
        if (selector === ".pane") return panes;
        return {};
      }),
    } as unknown as Page;

    const found = await treeOperations.waitForTreeItem.call(
      { getPage: () => page },
      "tasks",
      1_234,
      false,
      "Gradle Projects",
    );

    expect(found).toBe(true);
    expect(matchingPanes.filter).toHaveBeenCalledWith({ visible: true });
    expect(visiblePanes.getByRole).toHaveBeenCalledWith("treeitem", { name: "tasks" });
  });

  it("waits for an exact number of visible matches at a tree level", async () => {
    const count = vi.fn().mockResolvedValue(1);
    const visibleMatches = { count };
    const namedMatches = {
      filter: vi.fn().mockReturnValue(visibleMatches),
    };
    const levelMatches = {
      filter: vi.fn().mockReturnValue(namedMatches),
    };
    const page = {
      getByRole: vi.fn(),
      locator: vi.fn((selector: string) => {
        if (selector === '[role="treeitem"][aria-level="1"]') {
          return levelMatches;
        }
        return {};
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    const matched = await treeOperations.waitForTreeItemCount.call(
      { getPage: () => page },
      "simple",
      1,
      1_234,
      false,
      undefined,
      1,
    );

    expect(matched).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('[role="treeitem"][aria-level="1"]');
    expect(levelMatches.filter).toHaveBeenCalledWith({
      hasText: expect.any(RegExp),
    });
    expect(namedMatches.filter).toHaveBeenCalledWith({ visible: true });
    expect(count).toHaveBeenCalledOnce();
  });

  it("double-clicks an exact tree label before a fuzzy parent match", async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const scrollIntoViewIfNeeded = vi.fn().mockResolvedValue(undefined);
    const dblclick = vi.fn().mockResolvedValue(undefined);
    const link = { waitFor, scrollIntoViewIfNeeded, dblclick };
    const exactRow = {
      count: vi.fn().mockResolvedValue(1),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue(link),
      }),
    };
    const visibleExactMatches = {
      first: vi.fn().mockReturnValue(exactRow),
    };
    const exactMatches = {
      filter: vi.fn().mockReturnValue(visibleExactMatches),
    };
    const treeItems = {
      filter: vi.fn().mockReturnValue(exactMatches),
    };
    const page = {
      getByRole: vi.fn().mockReturnValue(treeItems),
      locator: vi.fn().mockReturnValue({}),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await treeOperations.doubleClickTreeItem.call(
      { getPage: () => page },
      "tasks",
    );

    expect(page.getByRole).toHaveBeenCalledWith("treeitem");
    expect(page.getByRole).not.toHaveBeenCalledWith("treeitem", { name: "tasks" });
    expect(exactRow.locator).toHaveBeenCalledWith("a");
    expect(dblclick).toHaveBeenCalledOnce();
  });
});
