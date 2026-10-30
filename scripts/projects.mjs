// Public project discovery and ranking do not depend on manually pinned items.
export function rankProjects(repos, login) {
  return repos.filter(r => r.name.toLowerCase() !== login.toLowerCase() && !r.isArchived)
    .sort((a, b) => b.stargazerCount - a.stargazerCount
      || b.forkCount - a.forkCount
      || (b.pushedAt || b.createdAt || '').localeCompare(a.pushedAt || a.createdAt || '')
      || a.name.localeCompare(b.name, 'en'));
}

export function projectDescription(repo, settings = {}, descriptions = {}) {
  for (const text of [repo.description, settings.description, descriptions[repo.name]]) {
    // Keep an English prefix in bilingual descriptions, without including a
    // partial Chinese sentence or requiring a translation service.
    const english = String(text || '').split(/\p{Script=Han}/u)[0].trim().replace(/[·|—–:（(\s]+$/u, '').trim();
    if (/[A-Za-z]{3}/.test(english)) return english;
  }
  return repo.primaryLanguage ? `A project built with ${repo.primaryLanguage.name}. Explore the code and documentation.`
    : 'Explore the source code, documentation and releases.';
}
