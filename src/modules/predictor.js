//-------------------------------------------------------------------------------
/*
Copyright (C) 2021-2022 Dino Bollinger, ETH Zürich, Information Security Group

This file is part of CookieBlock.

Released under the MIT License, see included LICENSE file.
*/
//-------------------------------------------------------------------------------


// Forests are populated by loadForests(), called from ensureInitialized() in cookieblock_sw.js.
// No top-level side effects — only the declaration lives here.
var forests = [undefined, undefined, undefined, undefined];

/**
 * Loads all 8 random-forest model JSON files and populates the `forests` array.
 * Each class model is split into two parts; the parts are concatenated to form
 * the full forest, matching the original nested-callback behaviour exactly.
 *
 * The four class models are loaded concurrently with Promise.all.
 * Called once by ensureInitialized() in cookieblock_sw.js.
 *
 * @returns {Promise<void>}
 */
const loadForests = async function() {
    const loadPair = async (url1, url2) => {
        const [part1, part2] = await Promise.all([
            fetchExtensionJSON(chrome.runtime.getURL(url1)),
            fetchExtensionJSON(chrome.runtime.getURL(url2))
        ]);
        return part1.concat(part2);
    };

    const [f0, f1, f2, f3] = await Promise.all([
        loadPair("/ext_data/model/forest_class0_part1.json", "/ext_data/model/forest_class0_part2.json"),
        loadPair("/ext_data/model/forest_class1_part1.json", "/ext_data/model/forest_class1_part2.json"),
        loadPair("/ext_data/model/forest_class2_part1.json", "/ext_data/model/forest_class2_part2.json"),
        loadPair("/ext_data/model/forest_class3_part1.json", "/ext_data/model/forest_class3_part2.json")
    ]);

    forests[0] = f0;  // Necessary
    forests[1] = f1;  // Functionality
    forests[2] = f2;  // Analytics
    forests[3] = f3;  // Advertising

    console.info("CookieBlock: all forest models loaded.");
};

/**
 * Given a tree node and corresponding features, retrieve the weight from the decision tree.
 * > Example Node: {"f": 470, "c": 0, "u": "l", "l": {}, "r": {}}
 * > Example Leaf: {"v": 32.0}
 * @param {Object} treeNode:  Root node of the tree, represented by a js object.
 * @param {Object} features:  Features to base decisions on. Any key not found is missing data.
 * @return {Promise<Number>}           The score resulting from the input features.
 */
 const traverseDecisionTree = function(rootNode, features){
    let treeNode = rootNode;
    while (true) {
        if ("v" in treeNode) {
            return treeNode["v"];
        } else {
            try {
                let fidx = treeNode["f"];
                if (!(fidx in features)) {
                    treeNode = treeNode[treeNode["u"]];
                } else if (features[fidx] < treeNode["c"]) {
                    treeNode = treeNode["l"];
                } else {
                    treeNode = treeNode["r"];
                }
            } catch (err) {
                console.error("Failed to traverse a tree.\nError: " + err.message);
                throw err;
            }
        }
    }
}

/**
 * Asynchronous function that produces a total class score from a single forest.
 * @param {Object} forest:   Forest object to traverse.
 * @param {Object} features: Extracted features in sparse object representation. {"index": value}
 * @returns {Promise<Number>}  Total score for the forest.
 */
const getForestScore = function(forest, features) {
    let treeScores = forest.map((root) => traverseDecisionTree(root, features));
    return treeScores.reduce((total, nv) => {return total + nv}, 0);
}


/**
* Predicts the category of the cookie using the extracted features.
* Rather than using XGBoost directly, we perform predictions using the decision tree dump.
* The object represents a sparse vector, with missing features being absent keys.
* @param {Object} features   Cookie features formatted as {"index": value}.
* @return {Promise<Number>}  The predicted label for the cookie.
*/
const predictClass = async function (features, nfactor){

    let existsUndefined = forests.reduce((total, f) => {return total || (f === undefined)}, false)
    if (existsUndefined) {
        throw new Error("At least one internal forest model was undefined!");
    }

    let minIndex = -1
    try {
        let classScores = [];
        for (let i = 0; i < forests.length; i++) {
            classScores.push(Math.exp(getForestScore(forests[i], features)));
        }
        let totalScore = classScores.reduce((total,num) => {return total + num}, 0);
        let probabilities = classScores.map((x) => {return x / totalScore});

        // Bayes Decision
        let minLoss = undefined;
        let lossWeights = [[0, 1, 1, 1], [nfactor, 0, 1, 1], [nfactor, 1, 0, 1], [nfactor, 1, 1, 0]];

        let cLoss;
        for (let j = 0; j < lossWeights.length; j++){
            cLoss = 0;
            for (let i = 0; i < probabilities.length; i++) {
                cLoss += probabilities[i] * lossWeights[j][i];
            }

            if (minLoss === undefined || cLoss < minLoss){
                minIndex = j;
                minLoss = cLoss;
            }
        }
    } catch(err) {
        console.error("Error while performing prediction: \n" + err.message)
    }

    return minIndex;
}
