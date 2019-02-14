import {WorkspaceRequiredError}                                                                  from '@berry/cli';
import {Cache, Configuration, Descriptor, MessageName, Plugin, Project, StreamReport, Workspace} from '@berry/core';
import {structUtils}                                                                             from '@berry/core';
import inquirer                                                                                  from 'inquirer';
import {Readable, Writable}                                                                      from 'stream';

import * as suggestUtils                                                                         from '../suggestUtils';

export default (concierge: any, plugins: Map<string, Plugin>) => concierge

  .command(`up [... packages] [-i,--interactive] [-v,--verbose] [-E,--exact] [-T,--tilde]`)
  .describe(`upgrade dependencies accross the project`)

  .detail(`
    This command upgrades a list of packages to their latest available version across the whole project (regardless of whether they're part of \`dependencies\` or \`devDependencies\` - \`peerDependencies\` won't be affected). This is a project-wide command: all workspaces will be upgraded in the process. Note that because such dependencies are expected to be non-upgradable, dependencies relying on non-semver ranges won't be updated (this includes git dependencies that use a commit hash).

    If \`-i,--interactive\` is set (or if the \`preferInteractive\` settings is toggled on) the command will offer various choices, depending on the detected upgrade paths. Some upgrades require this flag in order to resolve ambiguities.

    The \`-E,--exact\` and  \`-T,--tilde\` options have the same meaning as in the \`add\` command (they change the modifier used when the range is missing or a tag, and are ignored when the range is explicitly set).
  `)

  .example(
    `Upgrades all instances of lodash to the latest release`,
    `yarn up lodash`,
  )

  .example(
    `Upgrades all instances of lodash to 1.2.3`,
    `yarn up lodash@1.2.3`,
  )

  .action(async ({cwd, stdin, stdout, packages, exact, tilde, interactive}: {cwd: string, stdin: Readable, stdout: Writable, packages: Array<string>, exact: boolean, tilde: boolean, dev: boolean, peer: boolean, interactive: boolean}) => {
    const configuration = await Configuration.find(cwd, plugins);
    const {project, workspace} = await Project.find(configuration, cwd);
    const cache = await Cache.find(configuration);
  
    if (!workspace)
      throw new WorkspaceRequiredError(cwd);
  
    // @ts-ignore
    const prompt = inquirer.createPromptModule({
      input: stdin,
      output: stdout,
    });
  
    const modifier = exact
    ? suggestUtils.Modifier.EXACT
    : tilde
      ? suggestUtils.Modifier.TILDE
      : suggestUtils.Modifier.CARET;
  
    const strategies = interactive ? [
      suggestUtils.Strategy.KEEP,
      suggestUtils.Strategy.REUSE,
      suggestUtils.Strategy.PROJECT,
      suggestUtils.Strategy.LATEST,
    ] : [
      suggestUtils.Strategy.PROJECT,
      suggestUtils.Strategy.LATEST,
    ];
  
    const allSuggestionsPromises = [];
  
    for (const pseudoDescriptor of packages) {
      const descriptor = structUtils.parseDescriptor(pseudoDescriptor);
  
      for (const workspace of project.workspaces) {
        for (const target of [suggestUtils.Target.REGULAR, suggestUtils.Target.DEVELOPMENT]) {
          const existing = workspace.manifest[target].get(descriptor.identHash);
          if (!existing)
            continue;
  
          allSuggestionsPromises.push(Promise.resolve().then(async () => {
            return [
              workspace,
              target,
              existing,
              await suggestUtils.getSuggestedDescriptors(descriptor, existing, {project, cache, target, modifier, strategies})
            ] as [
              Workspace,
              suggestUtils.Target,
              Descriptor,
              Array<suggestUtils.Suggestion>
            ];
          }));
        }
      }
    }
  
    const allSuggestions = await Promise.all(allSuggestionsPromises);
  
    const checkReport = await StreamReport.start({configuration, stdout}, async report => {
      for (const [workspace, target, existing, suggestions] of allSuggestions) {
        if (suggestions.length === 0) {
          report.reportError(MessageName.CANT_SUGGEST_RESOLUTIONS, `${structUtils.prettyDescriptor(configuration, existing)} can't be resolved to a satisfying range`);
        } else if (suggestions.length > 1) {
          report.reportError(MessageName.CANT_SUGGEST_RESOLUTIONS, `${structUtils.prettyDescriptor(configuration, existing)} has multiple possible upgrade strategies; use -i to disambiguate manually`);
        }
      }
    });
  
    if (checkReport.hasErrors())
      return checkReport.exitCode();
  
    let askedQuestions = false;
  
    for (const [workspace, target, existing, suggestions] of allSuggestions) {
      let selected;
  
      if (suggestions.length === 1) {
        selected = suggestions[0];
      } else {
        askedQuestions = true;
        ({answer: selected} = await prompt({
          type: `list`,
          name: `answer`,
          message: `Which range to you want to use in ${structUtils.prettyWorkspace(configuration, workspace)} ❯ ${target}?`,
          choices: suggestions.map(({descriptor, reason}) => {
            return {
              name: reason,
              value: descriptor as Descriptor,
              short: structUtils.prettyDescriptor(project.configuration, descriptor),
            };
          }),
        }));
      }
  
      workspace.manifest[target].set(
        selected.identHash,
        selected,
      );
    }
  
    if (askedQuestions)
      stdout.write(`\n`);
  
    const installReport = await StreamReport.start({configuration, stdout}, async report => {
        await project.install({cache, report});
    });  
  
    return installReport.exitCode();
  });
