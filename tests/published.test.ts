import { expect, test } from "bun:test";
import { Published } from "../src/task/published";

test("a push says what it sent from its own output: the branch and the tag, to the repository", () => {
  const published = new Published();
  published.observe("cd ~/Documents/sensor-lib && git add -A && git commit -qm 'Release 0.3.5' && git tag v0.3.5 && git push origin main --tags",
    "To https://github.com/example/sensor-lib.git\n   0f1e2d3..1a2b3c4  main -> main\n * [new tag]         v0.3.5 -> v0.3.5\n", false);
  published.observe("cd ~/Documents/sensor-lib && gh release create v0.3.5 --latest --title 0.3.5 --notes 'x'",
    "https://github.com/example/sensor-lib/releases/tag/v0.3.5\n", false);
  expect(published.lines()).toEqual(["pushed main and tag v0.3.5 to example/sensor-lib", "created GitHub release v0.3.5"]);
});

test("a push that printed it sent refs counts even when a later command on the line failed; a refused one does not", () => {
  const published = new Published();
  published.observe("git push origin feature && npm test", "To git@github.com:o/r.git\n * [new branch]      feature -> feature\nnpm ERR! test failed\n", true);
  published.observe("git push", "To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\n", true);
  published.observe("gh release create v1", "HTTP 422: Validation Failed", true);
  published.observe("npm publish", "npm ERR! 403", true);
  expect(published.lines()).toEqual(["pushed feature to o/r"]);
});

test("pull requests, packages and images; a quiet push said from its words; reads are nothing", () => {
  const published = new Published();
  published.observe("gh pr create --fill", "https://github.com/o/r/pull/12\n", false);
  published.observe("gh pr merge 12 --squash", "", false);
  published.observe("npm publish --access public", "+ pkg@1.0.0", false);
  published.observe("docker push ghcr.io/o/app:1.0", "", false);
  published.observe("git push -q origin main", "", false);
  published.observe("git log --oneline -3 && gh release view v1", "abc\n", false);
  expect(published.lines()).toEqual(["pushed main to origin", "opened pull request o/r#12", "merged pull request 12", "published to npm", "pushed image ghcr.io/o/app:1.0"]);
});

test("not a push: git stash push, a log search, a dry run, and a push with nothing to send", () => {
  const published = new Published();
  published.observe("git stash push -m wip", "Saved working directory", false);
  published.observe("git log --grep push --oneline", "abc fix push", false);
  published.observe("git push --dry-run origin main", "To https://github.com/a/b.git\n   1111111..2222222  main -> main\n", false);
  published.observe("git push origin main", "Everything up-to-date\n", false);
  expect(published.lines()).toEqual([]);
  published.observe("git -C ../repo push origin main", "To https://github.com/a/b.git\n   1111111..2222222  main -> main\n", false);
  expect(published.lines()).toEqual(["pushed main to a/b"]);
});
