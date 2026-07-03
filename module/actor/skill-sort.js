// Skill sorting helpers — vendored into the module for the Augmented actor sheet (Option B). Mirror of
// the fork's module/actor/skill-sort.js with three module adaptations, kept otherwise byte-faithful so
// fork↔module diffs stay clean:
//   1. `realSkillValue` is inlined (the module has no CyberpunkActor document class to import it from);
//   2. the `trainedSkillsFirst` read targets the host SYSTEM setting (scope "cyberpunk2020"), guarded
//      with try/catch so a host that doesn't register it simply defaults the option off.

export { SortOrders, sortSkills }

// Effective skill value: chip level when chipped, else the trained level. Inlined from
// CyberpunkActor.realSkillValue so this file needs no actor-document import.
function realSkillValue(skill) {
    if (!skill) return 0;
    const data = skill.system ?? skill;
    let value = Number(data.level) || 0;
    const chipActive = !!(data.isChipped || data.autoChipped);
    if (chipActive) value = Number(data.chipLevel) || 0;
    return value;
}

// For now, these are arranged as they are in the book and on other sheets. But it seems a slightly arbitrary order, may change to match topstats, and have those in a sane order too.
// Order to consider stats in for skills. Lower values come first.
const statOrder = {
    // Don't have one of these be 0, that's falsy
    "role": 1,
    "int": 3,
    "ref": 4,
    "tech": 5,
    "cool": 6,
    "attr": 7,
    "luck": 8,
    "ma": 9,
    "bt": 10,
    "emp": 11,
}

const SortOrders = {
    Name: [byName],
    Stat: [byStat, byName]
}

// To sort hierarchically, break ties (0) with the return of another comparison function
export function byName(skillA, skillB) {
    // Locale-aware compare (matches the gear tab's Intl.Collator) so non-ASCII skill names sort by
    // collation order, not UTF-16 code points — matters for the RU localization goal.
    return String(skillA.name ?? "").localeCompare(String(skillB.name ?? ""));
}

export function hasPoints(skillA, skillB) {
    let aVal = realSkillValue(skillA);
    let bVal = realSkillValue(skillB);
    if(aVal > 0 && bVal === 0) {
        return -1;
    }
    else if(bVal > 0 && aVal === 0) {
        return 1;
    }
    else return 0;
}

function byStat(skillA, skillB) {
    let searchRank = (skill) => {
        if(skill.system.isRoleSkill)
            return statOrder["role"];
        return statOrder[skill.system.stat];
    };
    let order_a = searchRank(skillA) || -1;
    let order_b = searchRank(skillB) || -1;
    if(order_a > order_b) {
        return 1;
    }
    else if(order_a === order_b) {
        return 0;
    }
    return -1;
}

function hierarchical(functions) {
    return (skillA, skillB) => {
        for(const f of functions) {
            let sort = f(skillA, skillB);
            if(sort === 0)
                continue;
            else
                return sort;
        };
        return 0;
    }
}

/* This would usually be in actor-sheet.js; sorting stats is mostly for UX purposes. But that'd mean creating a sorted version of stats EVERY time the sheet opens. And CP2020 has 89 stats by default; enough for me to not want to do that. So we sort in the actor itself */
/**
 *
 * @param {*} skills
 * @param {*} compareFs Compare functions - sort by the first, then the second for any ties, third for any ties there etc. Some pre-made ones in SortOrders
 * @returns
 */
function sortSkills(skills, compareFs) {
    if(!compareFs) {
        console.warn("No sort order given. Returning original skill list");
        return skills;
    }
    let unsorted = skills.slice();
    let trainedFirst = false;
    // Host SYSTEM setting (scope "cyberpunk2020" = the base system's id), guarded for hosts lacking it.
    try { trainedFirst = game.settings.get("cyberpunk2020", "trainedSkillsFirst"); } catch (e) { /* default off */ }
    let firstFilter = trainedFirst ? [hasPoints] : [];

    return unsorted.sort(hierarchical(firstFilter.concat(compareFs)));
}
