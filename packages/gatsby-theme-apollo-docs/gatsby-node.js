const path = require('path');
const simpleGit = require('simple-git/promise');
const matter = require('gray-matter');
const semver = require('semver');
const match = require('semver-match');
const yaml = require('js-yaml');

function treeToObjects(tree) {
  return tree.split('\n').map(object => ({
    mode: object.slice(0, object.indexOf(' ')),
    path: object.slice(object.lastIndexOf('\t') + 1)
  }));
}

const configPaths = ['gatsby-config.js', '_config.yml'];
async function getSidebarCategories(git, tag) {
  // check for config paths in our current set of objects
  const tree = await git.raw(['ls-tree', '-r', tag]);
  const objects = treeToObjects(tree);
  const filePaths = objects.map(object => object.path);
  const existingConfig = configPaths.filter(configPath =>
    filePaths.includes(configPath)
  )[0];

  if (existingConfig) {
    const existingConfigText = await git.show([`${tag}:./${existingConfig}`]);

    if (/\.yml$/.test(existingConfig)) {
      // parse the config if it's YAML
      const yamlConfig = yaml.safeLoad(existingConfigText);
      return yamlConfig.sidebar_categories;
    }

    // TODO: handle js configs
  }

  return null;
}

const semverSegment = '\\d+(\\.\\d+){2}';
const tagPattern = new RegExp(`^v?${semverSegment}$`);

exports.createPages = async (
  {actions},
  {contentDir, root, githubRepo, sidebarCategories, versions: versionKeys, docs}
) => {
  const git = simpleGit(root);
  const remotes = await git.getRemotes();
  const hasOrigin = remotes.some(remote => remote.name === 'origin');
  if (!hasOrigin) {
    await git.addRemote('origin', `https://github.com/${githubRepo}.git`);
  }

  // update repo
  await git.fetch();
  const [owner, repo] = githubRepo.split('/');

  let currentVersion = 'HEAD';
  let sortedVersions = [currentVersion];
  let semvers = [];
  let semverMap = {};
  if (versionKeys) {
    const tagPatterns = [
      tagPattern,
      // account tags generated by lerna
      new RegExp(`^${repo}@${semverSegment}$`)
    ];

    // get a list of all tags that resemble a version
    const {all} = await git.tags({'--sort': '-v:refname'});
    const tags = all.filter(tag =>
      tagPatterns.some(pattern => pattern.test(tag))
    );

    semvers = tags.map(tag => {
      const {version} = semver.coerce(tag);
      return version;
    });

    semverMap = semvers.reduce(
      (acc, item, index) => ({
        ...acc,
        [item]: tags[index]
      }),
      {}
    );

    sortedVersions = versionKeys.sort().reverse();
    currentVersion = sortedVersions[0];
  }

  const versions = await Promise.all(
    sortedVersions.map(async version => {
      try {
        const semverMatch = match(version, semvers);
        const tag = semverMatch ? semverMap[semverMatch] : version;
        const tree = await git.raw(['ls-tree', '-r', '--full-tree', tag]);
        if (!tree) {
          return null;
        }

        // use the provided `sidebarCategories` from Gatsby config for the
        // current (latest) version, or grab the appropriate config file for
        // the version at hand
        const isCurrentVersion = version === currentVersion;
        const versionSidebarCategories = isCurrentVersion
          ? sidebarCategories
          : await getSidebarCategories(git, tag);

        if (!versionSidebarCategories) {
          throw new Error(
            `No sidebar configuration found for this version: ${tag}`
          );
        }

        // organize some arrays describing the repo contents that will be
        // useful later
        const objects = treeToObjects(tree);
        const markdown = objects.filter(({path}) => /\.mdx?$/.test(path));
        const markdownPaths = markdown.map(object => object.path);
        const docs = markdown.filter(({path}) => !path.indexOf(contentDir));

        const contents = [];
        const basePath = isCurrentVersion ? '/' : `/v${version}/`;
        for (const category in versionSidebarCategories) {
          const sidebarItems = versionSidebarCategories[category];
          const categoryContents = await Promise.all(
            sidebarItems.map(async sidebarItem => {
              if (typeof sidebarItem !== 'string') {
                // sidebar items can be an object with `title` and `href`
                // properties to render a regular anchor tag
                return {
                  path: sidebarItem.href,
                  title: sidebarItem.title,
                  anchor: true
                };
              }

              const filePath = `${contentDir}/${sidebarItem}.md`;
              const doc = docs.find(({path}) => path === filePath);
              if (!doc) {
                throw new Error(`Doc not found: ${filePath}@${version}`);
              }

              let text = await git.show([`${tag}:${filePath}`]);
              if (doc.mode === '120000') {
                // if the file is a symlink we need to follow it
                const directory = doc.path.slice(0, doc.path.lastIndexOf('/'));
                const symlink = path.resolve(`/${directory}`, text).slice(1);

                // ensure that the symlinked page exists because errors thrown
                // by `git.show` below cause subsequent git functions to fail
                if (!markdownPaths.includes(symlink)) {
                  return null;
                }

                text = await git.show([`${tag}:${symlink}`]);
              }

              const {content, data} = matter(text);
              return {
                ...data,
                content,
                path: basePath + sidebarItem.replace(/^index$/, ''),
                filePath
              };
            })
          );

          contents.push({
            title: category === 'null' ? null : category,
            pages: categoryContents.filter(Boolean)
          });
        }

        return {
          id: version,
          basePath,
          contents,
          owner,
          repo,
          tag,
          semverMatch
        };
      } catch (error) {
        console.error(error);
        return null;
      }
    })
  );

  const template = require.resolve('./src/components/template');
  versions.filter(Boolean).forEach((version, index, array) => {
    version.contents.forEach(({pages}) => {
      pages.forEach(({path, filePath, title, description, content, anchor}) => {
        if (anchor) {
          // don't create pages for sidebar links
          return;
        }

        actions.createPage({
          path,
          component: template,
          context: {
            content,
            title,
            description,
            version,
            filePath,
            docs,
            // use `array` here instead of `versions` because we're filtering
            // before the loop starts
            versions: array
          }
        });
      });
    });
  });
};
