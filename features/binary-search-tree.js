class BSTNode {
    index;
    data;
    left;
    right;
    parent;
    constructor(data, index) {
        this.data = data;
        this.index = index;
        this.left = null;
        this.right = null;
        this.parent = null;
    }
}
class BinarySearchTree {
    root;
    size;
    constructor() {
        this.root = null;
        this.size = 0;
    }
    insert(data, index) {
        const newNode = new BSTNode(data, index);
        if (!this.root) {
            this.root = newNode;
            this.size++;
            return newNode;
        }
        let current = this.root;
        while (true) {
            if (index < current.index) {
                if (!current.left) {
                    current.left = newNode;
                    newNode.parent = current;
                    this.size++;
                    return newNode;
                }
                current = current.left;
            }
            else if (index > current.index) {
                if (!current.right) {
                    current.right = newNode;
                    newNode.parent = current;
                    this.size++;
                    return newNode;
                }
                current = current.right;
            }
            else {
                current.data = data;
                return current;
            }
        }
    }
    find(index) {
        let current = this.root;
        while (current) {
            if (index === current.index) {
                return current;
            }
            else if (index < current.index) {
                current = current.left;
            }
            else {
                current = current.right;
            }
        }
        return null;
    }
    findMin(node = this.root) {
        if (!node)
            return null;
        while (node.left) {
            node = node.left;
        }
        return node;
    }
    findMax(node = this.root) {
        if (!node)
            return null;
        while (node.right) {
            node = node.right;
        }
        return node;
    }
    findPredecessor(node) {
        if (!node)
            return null;
        if (node.left) {
            return this.findMax(node.left);
        }
        let current = node;
        let parent = node.parent;
        while (parent && current === parent.left) {
            current = parent;
            parent = parent.parent;
        }
        return parent;
    }
    findSuccessor(node) {
        if (!node)
            return null;
        if (node.right) {
            return this.findMin(node.right);
        }
        let current = node;
        let parent = node.parent;
        while (parent && current === parent.right) {
            current = parent;
            parent = parent.parent;
        }
        return parent;
    }
    delete(index) {
        const nodeToDelete = this.find(index);
        if (!nodeToDelete)
            return false;
        this.size--;
        if (!nodeToDelete.left && !nodeToDelete.right) {
            if (nodeToDelete === this.root) {
                this.root = null;
            }
            else if (nodeToDelete === nodeToDelete.parent.left) {
                nodeToDelete.parent.left = null;
            }
            else {
                nodeToDelete.parent.right = null;
            }
        }
        else if (!nodeToDelete.left || !nodeToDelete.right) {
            const child = nodeToDelete.left || nodeToDelete.right;
            child.parent = nodeToDelete.parent;
            if (nodeToDelete === this.root) {
                this.root = child;
            }
            else if (nodeToDelete === nodeToDelete.parent.left) {
                nodeToDelete.parent.left = child;
            }
            else {
                nodeToDelete.parent.right = child;
            }
        }
        else {
            const successor = this.findSuccessor(nodeToDelete);
            nodeToDelete.data = successor.data;
            nodeToDelete.index = successor.index;
            if (!successor.right) {
                if (successor === successor.parent.left) {
                    successor.parent.left = null;
                }
                else {
                    successor.parent.right = null;
                }
            }
            else {
                successor.right.parent = successor.parent;
                if (successor === successor.parent.left) {
                    successor.parent.left = successor.right;
                }
                else {
                    successor.parent.right = successor.right;
                }
            }
        }
        return true;
    }
    deleteGreaterThan(index) {
        const nodesToDelete = [];
        this.inOrderTraversal((node) => {
            if (node.index > index) {
                nodesToDelete.push(node.index);
            }
        });
        nodesToDelete.forEach(nodeIndex => {
            this.delete(nodeIndex);
        });
    }
    inOrderTraversal(callback, node = this.root) {
        if (!node)
            return;
        this.inOrderTraversal(callback, node.left);
        callback(node);
        this.inOrderTraversal(callback, node.right);
    }
    toArray() {
        const result = [];
        this.inOrderTraversal((node) => {
            result.push({ data: node.data, index: node.index });
        });
        return result;
    }
    getSize() {
        return this.size;
    }
    clear() {
        this.root = null;
        this.size = 0;
    }
    isEmpty() {
        return this.size === 0;
    }
    getHeight(node = this.root) {
        if (!node)
            return -1;
        return 1 + Math.max(this.getHeight(node.left), this.getHeight(node.right));
    }
}

module.exports = BinarySearchTree;